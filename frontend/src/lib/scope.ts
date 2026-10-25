/** Plain-language description of a signed-in employee's data scope (backend/auth.py `_scope`). */
export function scopeText(level: string, department: string, projects: string[]): string {
  if (level === 'all') return 'all departments and projects';
  if (level === 'department') return `${department} department`;
  if (level === 'project') return `projects ${projects.join(', ')}`;
  return 'your own licences and requests';
}

/** Open the assistant drawer from anywhere, optionally with a first question. */
export function openAssistant(question?: string) {
  window.dispatchEvent(new CustomEvent('kpcl:assistant', { detail: question ?? null }));
}
