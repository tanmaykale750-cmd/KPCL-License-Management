import type { RoleId, User } from '../domain/types';

/** Named sample people. All fictional. */
export const KEY_USERS: User[] = [
  { id: 'u-priya', name: 'Priya Nair', username: 'pnair', deptId: 'it', team: 'PLM Support', grade: 'M1', title: 'Licence Administrator' },
  { id: 'u-harish', name: 'Harish Kulkarni', username: 'hkulkarni', deptId: 'sim', team: 'Structural CAE', grade: 'M2', title: 'Head, Simulation & Analysis' },
  { id: 'u-meera', name: 'Meera Joshi', username: 'mjoshi', deptId: 'design', team: 'Compressor Design', grade: 'M2', title: 'Head, Mechanical Design' },
  { id: 'u-sanjay', name: 'Sanjay Deshpande', username: 'sdeshpande', deptId: 'engg', team: 'Product Engineering', grade: 'M2', title: 'Head, Product Engineering' },
  { id: 'u-anjali', name: 'Anjali Rao', username: 'arao', deptId: 'rnd', team: 'Advanced Development', grade: 'M2', title: 'Head, R&D' },
  { id: 'u-vikram', name: 'Vikram Patil', username: 'vpatil', deptId: 'mfg', team: 'Process Engineering', grade: 'M2', title: 'Head, Manufacturing Engineering' },
  { id: 'u-neha', name: 'Neha Sathe', username: 'nsathe', deptId: 'it', team: 'PLM Support', grade: 'M2', title: 'Head, IT & PLM' },
  { id: 'u-rohit', name: 'Rohit Agarwal', username: 'ragarwal', deptId: 'it', team: 'Finance', grade: 'M2', title: 'Finance Controller' },
  { id: 'u-amit', name: 'Amit Gokhale', username: 'agokhale', deptId: 'design', team: 'Compressor Design', grade: 'M1', title: 'Project Leader, Project X' },
  { id: 'u-kavita', name: 'Kavita Shinde', username: 'kshinde', deptId: 'engg', team: 'Gearbox & Transmission', grade: 'M1', title: 'Project Leader, Project Y' },
  { id: 'u-sneha', name: 'Sneha Bhosale', username: 'sbhosale', deptId: 'sim', team: 'CFD & Thermal', grade: 'M1', title: 'Project Leader, CFD' },
  { id: 'u-arjun', name: 'Arjun Menon', username: 'amenon', deptId: 'rnd', team: 'Controls & Electronics', grade: 'M1', title: 'Project Leader, Controller board' },
  { id: 'u-ganesh', name: 'Ganesh Pawar', username: 'gpawar', deptId: 'mfg', team: 'Tooling & Fixtures', grade: 'M1', title: 'Project Leader, Fixtures' },
  { id: 'u-rahul', name: 'Rahul Patil', username: 'rpatil', deptId: 'sim', team: 'Structural CAE', grade: 'E2', title: 'CAE Engineer' },
];

export const TEAMS: Record<string, string[]> = {
  design: ['Compressor Design', 'Packaging & Skids'],
  engg: ['Product Engineering', 'Gearbox & Transmission'],
  sim: ['Structural CAE', 'CFD & Thermal'],
  rnd: ['Controls & Electronics', 'Advanced Development'],
  mfg: ['Tooling & Fixtures', 'Process Engineering'],
  it: ['PLM Support'],
};

export const FIRST = ['Aditya', 'Akshay', 'Ankita', 'Ashwini', 'Chetan', 'Deepak', 'Devika', 'Gauri', 'Hemant', 'Ishaan', 'Jayant', 'Kiran', 'Ketaki', 'Mahesh', 'Manasi', 'Nikhil', 'Nilesh', 'Omkar', 'Pallavi', 'Pooja', 'Prasad', 'Rajesh', 'Rasika', 'Rohan', 'Sachin', 'Sagar', 'Sakshi', 'Shreyas', 'Shruti', 'Siddharth', 'Snehal', 'Sunil', 'Swati', 'Tejas', 'Tanvi', 'Umesh', 'Varsha', 'Vinay', 'Yash', 'Yogita'];
export const LAST = ['Apte', 'Bapat', 'Chavan', 'Dange', 'Gadgil', 'Ghorpade', 'Inamdar', 'Jadhav', 'Kale', 'Karve', 'Khare', 'Lele', 'Mane', 'More', 'Naik', 'Oak', 'Paranjape', 'Phadke', 'Ranade', 'Sawant', 'Shah', 'Tilak', 'Vaidya', 'Wagh'];

export interface Persona {
  role: RoleId;
  userId: string;
  roleLabel: string;
  scopeLabel: string;
}

/**
 * The four sign-in profiles. `userId` is the sample-data person used only when the signed-in employee has no record in
 * the sample dataset; the scope label shown in the app comes from the signed-in employee's record (see state/store).
 */
export const PERSONAS: Persona[] = [
  { role: 'admin', userId: 'u-priya', roleLabel: 'Admin (Head)', scopeLabel: 'Everything: all departments, projects, licences and costs' },
  { role: 'deptHead', userId: 'u-harish', roleLabel: 'Department Head', scopeLabel: 'Their department' },
  { role: 'projectLead', userId: 'u-amit', roleLabel: 'Project Head', scopeLabel: 'Their projects' },
  { role: 'engineer', userId: 'u-rahul', roleLabel: 'Engineer', scopeLabel: 'Their licences and requests' },
];
