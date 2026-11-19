import { invoke } from '@tauri-apps/api/core';

// Typed access to the project, git and GitHub commands of the desktop app (src-tauri/src/workspace.rs).
// The GitHub token stays on the Rust side: nothing here ever receives it.

/** A remembered project folder plus what git says about it right now. */
export interface ProjectInfo {
  id: string;
  name: string;
  /** Absolute folder. */
  path: string;
  /** URL of the `origin` remote. */
  remote: string | null;
  exists: boolean;
  isRepo: boolean;
  branch: string | null;
}

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'typechange' | 'conflicted';

export interface ProjectEntry {
  name: string;
  /** Relative to the project folder, `/`-separated. */
  path: string;
  kind: 'dir' | 'file';
  size: number;
  modified: number;
  /** For a folder: something inside it changed. */
  git?: GitFileStatus;
}

export interface RepoStatus {
  isRepo: boolean;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  remote: string | null;
  state: string;
  files: { path: string; status: GitFileStatus; staged: boolean }[];
}

export interface Branches {
  current: string | null;
  local: string[];
  remote: string[];
}

export interface CommitResult {
  commit: string;
  branch: string | null;
  files: number;
}

export interface PullResult {
  result: 'up-to-date' | 'fast-forward' | 'merged';
  branch: string;
  commit: string | null;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubAccount {
  configured: boolean;
  clientId: string | null;
  clientIdFromSettings: boolean;
  user: GitHubUser | null;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubRepo {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string | null;
  updatedAt: string | null;
}

export const projectsApi = {
  list: () => invoke<ProjectInfo[]>('project_list'),
  add: (path: string, name?: string) => invoke<ProjectInfo>('project_add', { path, name }),
  remove: (id: string) => invoke<void>('project_remove', { id }),
  rename: (id: string, name: string) => invoke<ProjectInfo>('project_rename', { id, name }),
  listDir: (projectId: string, dir: string) => invoke<ProjectEntry[]>('project_list_dir', { projectId, dir }),
  readText: (projectId: string, path: string) => invoke<string>('project_read_text', { projectId, path }),
  readBinary: (projectId: string, path: string) => invoke<string>('project_read_binary', { projectId, path }),
  /** Resolves to the absolute path written. */
  writeText: (projectId: string, path: string, contents: string) => invoke<string>('project_write_text', { projectId, path, contents }),
  writeBinary: (projectId: string, path: string, base64: string) => invoke<string>('project_write_binary', { projectId, path, base64 }),
  createDir: (projectId: string, path: string) => invoke<void>('project_create_dir', { projectId, path }),
  /** Resolves to the new relative path. */
  move: (projectId: string, from: string, to: string) => invoke<string>('project_move', { projectId, from, to }),
  trash: (projectId: string, path: string) => invoke<void>('project_trash', { projectId, path }),
  reveal: (projectId: string, path?: string) => invoke<void>('project_reveal', { projectId, path }),
};

export const gitApi = {
  status: (projectId: string) => invoke<RepoStatus>('git_status', { projectId }),
  branches: (projectId: string, fetch = false) => invoke<Branches>('git_branches', { projectId, fetch }),
  switchBranch: (projectId: string, branch: string) => invoke<string>('git_switch_branch', { projectId, branch }),
  commit: (projectId: string, message: string, files?: string[]) => invoke<CommitResult>('git_commit', { projectId, message, files }),
  pull: (projectId: string) => invoke<PullResult>('git_pull', { projectId }),
  push: (projectId: string) => invoke<string>('git_push', { projectId }),
};

export const githubApi = {
  account: () => invoke<GitHubAccount>('github_account'),
  setClientId: (clientId: string | null) => invoke<void>('github_set_client_id', { clientId }),
  /** Also opens the verification page in the system browser. */
  loginStart: () => invoke<DeviceCode>('github_login_start'),
  /** Resolves once the user confirmed the code on GitHub. */
  loginWait: () => invoke<GitHubUser>('github_login_wait'),
  /** Signs in with a personal access token; it goes straight to the OS credential store. */
  loginToken: (token: string) => invoke<GitHubUser>('github_login_token', { token }),
  loginCancel: () => invoke<void>('github_login_cancel'),
  logout: () => invoke<void>('github_logout'),
  repos: (query?: string) => invoke<GitHubRepo[]>('github_repos', { query }),
  owners: () => invoke<string[]>('github_owners'),
  createRepo: (owner: string, name: string, isPrivate: boolean, description?: string) =>
    invoke<GitHubRepo>('github_create_repo', { owner, name, private: isPrivate, description }),
  clone: (cloneUrl: string, parent: string, name: string) => invoke<ProjectInfo>('github_clone', { cloneUrl, parent, name }),
};
