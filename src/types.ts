export type Project = {
  id: string;
  name: string;
  description: string;
  /** "repo" marks a project imported from an existing Git repository. */
  template: "web" | "react" | "repo";
  source?: { url: string; branch?: string };
  createdAt: string;
  updatedAt: string;
};
export type GithubRepo = {
  id: string;
  name: string;
  private: boolean;
  url: string;
  cloneUrl: string;
  branch: string;
  description?: string;
  updatedAt?: string;
  sizeKb?: number;
};
export type FileEntry = {
  path: string;
  name: string;
  type: "file" | "directory";
  size?: number;
};
export type Job = {
  id: string;
  projectId: string;
  kind: "terminal" | "agent" | "build" | "git";
  title: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  output: string;
  createdAt: string;
  finishedAt?: string;
  exitCode?: number;
};
export type Connection = {
  id: string;
  name: string;
  status: "connected" | "missing" | "error";
  detail: string;
  authMode?: "api" | "chatgpt" | "claude_code" | "disabled";
  fields: {
    key: string;
    label: string;
    secret?: boolean;
    placeholder?: string;
  }[];
};
export type Model = {
  id: string;
  name: string;
  efforts: string[];
  speeds: string[];
};
export type Build = {
  id: string;
  appId: string;
  workflowId: string;
  status: string;
  startedAt: string;
  branch: string;
  artifacts: { name: string; url: string }[];
};
export type GitRemote = {
  url: string;
  label: string;
  webUrl?: string;
  upstream: string | null;
  ahead: number;
  behind: number;
};
export type GitState = {
  branch: string;
  changes: { path: string; status: string }[];
  log: { hash: string; message: string; date: string }[];
  remote?: GitRemote | null;
};
export type ToastFn = (message: string, kind?: "success" | "error") => void;
