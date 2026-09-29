export type Project = {
  id: string;
  name: string;
  description: string;
  template: "web" | "react";
  createdAt: string;
  updatedAt: string;
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
  kind: "terminal" | "agent" | "build";
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
export type GitState = {
  branch: string;
  changes: { path: string; status: string }[];
  log: { hash: string; message: string; date: string }[];
};
export type ToastFn = (message: string, kind?: "success" | "error") => void;
