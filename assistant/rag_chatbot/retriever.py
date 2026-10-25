"""
Hybrid retriever: BM25 (lexical, exact IDs) + TF-IDF cosine (1-2 grams), score-normalised and combined,
then re-ranked with entity matching (portfolio / software / project) and question-intent boosts.

No external model download is needed, so it runs offline on any machine.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np
from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer

from .entities import SOFTWARE_ALIASES, Entities, extract
from .knowledge_base import Document

STOP = set("""a an the of to in on for and or is are was were be been it its this that these those with as at by from
what which who how why when where do does did can could should would will shall may might me my we our you your i
about tell show give please there their them they than then so if into vs per any all some more most very much
""".split())
_TOKEN = re.compile(r"[a-z0-9]+(?:[-.][a-z0-9]+)*")


def tokenize(text: str) -> list[str]:
    toks = _TOKEN.findall((text or "").lower())
    return [t for t in toks if t not in STOP and (len(t) > 1 or t.isdigit())]


INTENTS = {
    "accuracy": (r"accura|reliab|trust|\bmae\b|error|wape|\br2\b|coverage|hold-?out|validat|how good|precision|"
                 r"recall|\bauc\b|overfit|which model|what model|best model|compar|leaderboard|ensemble|selected model",
                 {"model_accuracy": 0.7, "model_method": 0.1}),
    "recommendation": (r"recommend|action|should|advice|advis|suggest|what to do|buy|reduc|renew|temporar|purchas|"
                       r"saving|next step|decision|option|cost",
                       {"pool_rec_m3": 0.3, "pool_rec_m2": 0.3, "software_rec_m3": 0.2}),
    "forecast": (r"forecast|predict|peak|demand|next month|shortage|risk|utili|\bp90\b|\bp50\b|need|month",
                 {"pool_forecast": 0.3}),
    "method": (r"how does|how is|how do|method|work|algorithm|monte carlo|feature|trained|training|model|engine|"
               r"grid search|newsvendor|xgboost|decide", {"model_method": 0.45, "engine_method": 0.45}),
    "glossary": (r"what is|what does|mean|definition|stand for|explain .*term", {"glossary": 0.7}),
    "whatif": (r"what if|what-if|if we|delay|cancel|scenario|team size", {"whatif_example": 0.2, "pool_rec_m2": 0.1}),
    "explain": (r"why|driver|explain|reason|because|cause", {"explanation_sample": 0.15, "pool_rec_m3": 0.1,
                                                             "pool_rec_m2": 0.1}),
    "assumption": (r"assum|tolerance|buffer|threshold|multiplier|synthetic|price", {"assumption": 0.7, "glossary": 0.2}),
}


def detect_intents(q: str) -> list[str]:
    ql = (q or "").lower()
    return [name for name, (pat, _) in INTENTS.items() if re.search(pat, ql)]


@dataclass
class Hit:
    doc: Document
    score: float
    lexical: float
    semantic: float
    boost: float


class HybridRetriever:
    def __init__(self, docs: list[Document], k1: float = 1.5, b: float = 0.75):
        if not docs:
            raise ValueError("No documents to index")
        self.docs = docs
        corpus = [self._index_text(d) for d in docs]
        # BM25
        self.cv = CountVectorizer(tokenizer=tokenize, lowercase=False, token_pattern=None)
        tf = self.cv.fit_transform(corpus).tocsc().astype(float)
        n = tf.shape[0]
        dl = np.asarray(tf.sum(axis=1)).ravel()
        avg = dl.mean() if n else 1.0
        df = np.diff(tf.indptr)
        idf = np.log(1 + (n - df + 0.5) / (df + 0.5))
        tf = tf.tocoo()
        denom = tf.data + k1 * (1 - b + b * dl[tf.row] / avg)
        data = idf[tf.col] * tf.data * (k1 + 1) / denom
        from scipy.sparse import csc_matrix
        self.bm25 = csc_matrix((data, (tf.row, tf.col)), shape=tf.shape)
        # TF-IDF
        self.tfidf = TfidfVectorizer(tokenizer=tokenize, lowercase=False, token_pattern=None, ngram_range=(1, 2),
                                     sublinear_tf=True, min_df=1)
        self.tm = self.tfidf.fit_transform(corpus)
        self.by_id = {d.id: d for d in docs}

    @staticmethod
    def _index_text(d: Document) -> str:
        m = d.meta or {}
        extra = " ".join(str(m.get(k, "")) for k in ("portfolio_id", "software_id", "software_name", "action"))
        extra += " " + " ".join(m.get("projects", []) or [])
        return f"{d.title} {d.title} {extra} {d.text}"

    def _lexical(self, q: str) -> np.ndarray:
        vocab = self.cv.vocabulary_
        idx = [vocab[t] for t in tokenize(q) if t in vocab]
        if not idx:
            return np.zeros(len(self.docs))
        return np.asarray(self.bm25[:, idx].sum(axis=1)).ravel()

    def _semantic(self, q: str) -> np.ndarray:
        v = self.tfidf.transform([q])
        if v.nnz == 0:
            return np.zeros(len(self.docs))
        return np.asarray((self.tm @ v.T).todense()).ravel()

    @staticmethod
    def _norm(x: np.ndarray) -> np.ndarray:
        mx = x.max() if len(x) else 0
        return x / mx if mx > 0 else x

    @staticmethod
    def effective_intents(intents: list[str], ents: Entities) -> list[str]:
        """Resolve overlapping intents: 'how accurate is the forecast' is about accuracy, not about a forecast;
        'how does the engine decide on temporary access' is about the method, not about one pool."""
        it = list(intents)
        if "accuracy" in it:
            it = [x for x in it if x not in ("forecast",)]
        if ("method" in it or "glossary" in it) and not ents.portfolios:
            it = [x for x in it if x not in ("forecast", "recommendation", "whatif", "explain")]
        return it

    def _boosts(self, ents: Entities, intents: list[str]) -> np.ndarray:
        intents = self.effective_intents(intents, ents)
        out = np.zeros(len(self.docs))
        for i, d in enumerate(self.docs):
            m = d.meta or {}
            pf, sw = m.get("portfolio_id"), m.get("software_id")
            s = 0.0
            if ents.portfolios:
                if pf in ents.portfolios:
                    s += 0.45
                elif pf:
                    s -= 0.6        # another pool's document
            if ents.software:
                if sw in ents.software:
                    s += 0.35
                elif sw:
                    s -= 0.45
                elif any(SOFTWARE_ALIASES[x][0] in d.text.lower() for x in ents.software if x in SOFTWARE_ALIASES):
                    s += 0.3        # general doc (e.g. accuracy by software) that talks about this software
            if ents.portfolios and ents.software and pf and sw:
                if pf in ents.portfolios and sw in ents.software:
                    s += 0.6        # exact pool
                else:
                    s -= 0.5        # a different pool when the user named an exact pool
            if ents.projects and set(ents.projects) & set(m.get("projects", []) or []):
                s += 0.3
            if ents.months and set(ents.months) & set(m.get("months", []) or []):
                s += 0.05
            for it in intents:
                s += INTENTS[it][1].get(d.doc_type, 0.0)
            out[i] = s
        return out

    def search(self, query: str, k: int = 8, entities: Entities | None = None, per_type_cap: int = 3,
               doc_types: set[str] | None = None) -> list[Hit]:
        ents = entities if entities is not None else extract(query)
        intents = detect_intents(query)
        lex, sem = self._norm(self._lexical(query)), self._norm(self._semantic(query))
        boost = self._boosts(ents, intents)
        score = 0.5 * lex + 0.5 * sem + boost
        order = np.argsort(-score)
        hits, per_type = [], {}
        for i in order:
            d = self.docs[i]
            if doc_types and d.doc_type not in doc_types:
                continue
            if score[i] <= 0 and hits:
                break
            if per_type.get(d.doc_type, 0) >= per_type_cap:
                continue
            per_type[d.doc_type] = per_type.get(d.doc_type, 0) + 1
            hits.append(Hit(d, float(score[i]), float(lex[i]), float(sem[i]), float(boost[i])))
            if len(hits) >= k:
                break
        return hits

    def get(self, doc_id: str) -> Document | None:
        return self.by_id.get(doc_id)

    def pool_documents(self, portfolio_id: str, software_id: str) -> list[Document]:
        """The three core documents of a pool (ML forecast, simulation recommendation, engine recommendation)."""
        ids = [f"forecast:{portfolio_id}:{software_id}", f"m2rec:{portfolio_id}:{software_id}",
               f"m3pool:{portfolio_id}:{software_id}"]
        return [self.by_id[i] for i in ids if i in self.by_id]


def safe_float(x, default=math.nan):
    try:
        return float(x)
    except (TypeError, ValueError):
        return default
