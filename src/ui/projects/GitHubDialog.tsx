import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Copy, FolderOpen, LoaderCircle, Lock, LogOut, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { githubApi, type DeviceCode, type GitHubRepo } from '../../bridge/projects';
import { useT } from '../../i18n';
import { Segmented, Switch } from '../controls';
import { notifyError, notifySuccess } from '../toast';
import { inputClass, labelClass, outlineButton, primaryButton, ProjectDialog, quietButton } from './dialogParts';
import { folderForRepo } from './projectModel';
import { adoptProject, loadAccount, logout, useProjects } from './projectsStore';

const PARENT_KEY = 'tessel.projects.cloneFolder';

function rememberedParent(): string {
  try {
    return globalThis.localStorage?.getItem(PARENT_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberParent(path: string): void {
  try {
    globalThis.localStorage?.setItem(PARENT_KEY, path);
  } catch {
    // Only a convenience.
  }
}

/** The folder that clones go into, with a button to choose another. */
function ParentFolder({ value, onChange }: { value: string; onChange(path: string): void }) {
  const t = useT().projects;
  const choose = async () => {
    const path = await openDialog({ directory: true, multiple: false, title: t.chooseCloneFolder });
    if (!path) return;
    rememberParent(path);
    onChange(path);
  };
  return (
    <div className="flex items-center gap-2">
      <span className={`${labelClass} shrink-0`}>{t.cloneInto}</span>
      <button className={`${outlineButton} flex min-w-0 flex-1 items-center gap-2 text-left font-normal`} onClick={() => void choose()}>
        <FolderOpen size={14} strokeWidth={1.75} className="shrink-0" />
        <span className={`min-w-0 flex-1 truncate ${value ? '' : 'text-faint'}`}>{value || t.chooseCloneFolder}</span>
      </button>
    </div>
  );
}

/** Fallback sign-in with a personal access token (builds without a client id, organisations that block OAuth Apps). */
function TokenSignIn({ open }: { open?: boolean }) {
  const t = useT().projects;
  const [token, setToken] = useState('');
  const [working, setWorking] = useState(false);
  const submit = async () => {
    setWorking(true);
    try {
      const user = await githubApi.loginToken(token);
      setToken('');
      notifySuccess(t.signedIn, user.login);
      await loadAccount();
    } catch (error) {
      notifyError(error);
    } finally {
      setWorking(false);
    }
  };
  return (
    <details open={open} className="text-[calc(12.5px*var(--font-scale))] text-dim">
      <summary className="cursor-pointer select-none text-faint hover:text-dim">{t.tokenSignIn}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="leading-relaxed text-faint">{t.tokenHint}</p>
        <div className="flex gap-2">
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            className={inputClass}
            placeholder="ghp_… / github_pat_…"
            aria-label={t.tokenSignIn}
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && token.trim()) void submit();
            }}
          />
          <button className={outlineButton} disabled={!token.trim() || working} onClick={() => void submit()}>
            {working ? <LoaderCircle size={14} className="animate-spin" /> : t.tokenButton}
          </button>
        </div>
      </div>
    </details>
  );
}

function SignIn() {
  const dict = useT();
  const t = dict.projects;
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => () => void githubApi.loginCancel().catch(() => undefined), []);

  const start = async () => {
    try {
      setWaiting(true);
      const device = await githubApi.loginStart();
      setCode(device);
      const user = await githubApi.loginWait();
      notifySuccess(t.signedIn, user.login);
      await loadAccount();
    } catch (error) {
      notifyError(error);
      setCode(null);
    } finally {
      setWaiting(false);
    }
  };
  const cancel = () => {
    void githubApi.loginCancel();
    setCode(null);
    setWaiting(false);
  };

  if (!code) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">{t.signInText}</p>
        <button className={primaryButton} disabled={waiting} onClick={() => void start()}>
          {waiting ? <LoaderCircle size={14} className="animate-spin" /> : t.signIn}
        </button>
        <TokenSignIn />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <p className="text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">{t.enterCode}</p>
      <div className="flex items-center gap-2">
        <code className="rounded-lg bg-ink px-4 py-2 font-mono text-[calc(22px*var(--font-scale))] font-semibold tracking-[0.15em] text-text ring-1 ring-line-strong">
          {code.userCode}
        </code>
        <button
          aria-label={t.copyCode}
          title={t.copyCode}
          className="flex size-8 items-center justify-center rounded-md text-dim hover:bg-raised hover:text-text"
          onClick={() => void navigator.clipboard.writeText(code.userCode).then(() => notifySuccess(t.copied))}
        >
          <Copy size={15} strokeWidth={1.75} />
        </button>
      </div>
      <p className="text-[calc(12.5px*var(--font-scale))] text-faint">{t.browserOpened(code.verificationUri)}</p>
      <p className="flex items-center gap-2 text-[calc(12.5px*var(--font-scale))] text-dim">
        <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
        {t.waitingForGitHub}
      </p>
      <button className={quietButton} onClick={cancel}>
        {dict.dialogs.cancel}
      </button>
    </div>
  );
}

function RepoList({ parent, onParent }: { parent: string; onParent(path: string): void }) {
  const t = useT().projects;
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const [query, setQuery] = useState('');
  const [cloning, setCloning] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    githubApi
      .repos()
      .then((list) => current && setRepos(list))
      .catch((error) => {
        notifyError(error);
        void loadAccount();
      });
    return () => {
      current = false;
    };
  }, []);

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (repos ?? []).filter((repo) => {
      const text = `${repo.fullName} ${repo.description ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [repos, query]);

  const clone = async (repo: GitHubRepo) => {
    if (!parent) return;
    setCloning(repo.fullName);
    try {
      const project = await githubApi.clone(repo.cloneUrl, parent, folderForRepo(repo.fullName));
      notifySuccess(t.cloned, project.path);
      useProjects.setState({ githubOpen: false });
      await adoptProject(project);
    } catch (error) {
      notifyError(error);
    } finally {
      setCloning(null);
    }
  };

  return (
    <>
      <ParentFolder value={parent} onChange={onParent} />
      <label className="relative">
        <Search size={14} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
        <input autoFocus className={`${inputClass} pl-8`} placeholder={t.searchRepos} aria-label={t.searchRepos} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
      </label>
      {repos === null ? (
        <p className={`${labelClass} flex items-center gap-2`}>
          <LoaderCircle size={14} className="animate-spin" />
          {t.loading}
        </p>
      ) : shown.length === 0 ? (
        <p className={labelClass}>{repos.length === 0 ? t.noRepos : t.noMatches}</p>
      ) : (
        <ul className="flex max-h-80 flex-col gap-px overflow-y-auto rounded-md bg-ink p-1 ring-1 ring-line ring-inset">
          {shown.map((repo) => (
            <li key={repo.fullName} className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 hover:bg-raised">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[calc(13px*var(--font-scale))] text-text">
                  <span className="min-w-0 truncate">{repo.fullName}</span>
                  {repo.private && <Lock size={12} strokeWidth={2} className="shrink-0 text-faint" aria-label={t.private} />}
                </div>
                {repo.description && <p className="truncate text-[calc(12px*var(--font-scale))] text-faint">{repo.description}</p>}
              </div>
              <button
                className={`${outlineButton} h-7 shrink-0 px-2.5`}
                disabled={!parent || cloning !== null}
                title={parent ? undefined : t.chooseCloneFolder}
                onClick={() => void clone(repo)}
              >
                {cloning === repo.fullName ? <LoaderCircle size={14} className="animate-spin" /> : t.clone}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CreateRepo({ parent, onParent }: { parent: string; onParent(path: string): void }) {
  const t = useT().projects;
  const [owners, setOwners] = useState<string[]>([]);
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setPrivate] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    githubApi
      .owners()
      .then((list) => {
        setOwners(list);
        setOwner((current) => current || list[0] || '');
      })
      .catch(notifyError);
  }, []);

  const valid = /^[A-Za-z0-9._-]+$/.test(name) && owner !== '' && parent !== '';
  const create = async () => {
    setWorking(true);
    try {
      const repo = await githubApi.createRepo(owner, name, isPrivate, description || undefined);
      const project = await githubApi.clone(repo.cloneUrl, parent, repo.name);
      notifySuccess(t.created, repo.fullName);
      useProjects.setState({ githubOpen: false });
      await adoptProject(project);
    } catch (error) {
      notifyError(error);
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>{t.owner}</span>
        <select className={inputClass} value={owner} onChange={(e) => setOwner(e.currentTarget.value)}>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>{t.repoName}</span>
        <input className={inputClass} placeholder="survival-models" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        {name !== '' && !/^[A-Za-z0-9._-]+$/.test(name) && <span className="text-[calc(12px*var(--font-scale))] text-danger">{t.repoNameRule}</span>}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>{t.description}</span>
        <input className={inputClass} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
      </label>
      <div className="flex items-center justify-between">
        <span className={labelClass}>{t.privateRepo}</span>
        <Switch checked={isPrivate} label={t.privateRepo} onChange={setPrivate} />
      </div>
      <ParentFolder value={parent} onChange={onParent} />
      <div className="flex justify-end">
        <button className={primaryButton} disabled={!valid || working} onClick={() => void create()}>
          {working ? <LoaderCircle size={14} className="animate-spin" /> : t.createAndClone}
        </button>
      </div>
    </>
  );
}

function ClientIdSetting() {
  const t = useT().projects;
  const account = useProjects((s) => s.account);
  const [value, setValue] = useState(account?.clientIdFromSettings ? (account.clientId ?? '') : '');
  const save = async (clientId: string | null) => {
    try {
      await githubApi.setClientId(clientId);
      await loadAccount();
      notifySuccess(t.clientIdSaved);
    } catch (error) {
      notifyError(error);
    }
  };
  return (
    <details className="text-[calc(12.5px*var(--font-scale))] text-dim">
      <summary className="cursor-pointer select-none text-faint hover:text-dim">{t.settings}</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="leading-relaxed text-faint">{t.clientIdHint}</p>
        <div className="flex gap-2">
          <input className={inputClass} placeholder={account?.clientId ?? 'Ov23li…'} aria-label={t.clientId} value={value} onChange={(e) => setValue(e.currentTarget.value)} />
          <button className={outlineButton} onClick={() => void save(value.trim() || null)}>
            {t.saveClientId}
          </button>
        </div>
      </div>
    </details>
  );
}

/** GitHub: sign in with a device code, then clone a repository or create a new one as a project. */
export function GitHubDialog() {
  const t = useT().projects;
  const open = useProjects((s) => s.githubOpen);
  const account = useProjects((s) => s.account);
  const [tab, setTab] = useState<'clone' | 'create'>('clone');
  const [parent, setParent] = useState(rememberedParent);
  const close = () => useProjects.setState({ githubOpen: false });

  useEffect(() => {
    if (open) void loadAccount();
  }, [open]);

  const user = account?.user ?? null;
  return (
    <ProjectDialog open={open} onClose={close} title={t.githubTitle} width="36rem">
      {account === null ? (
        <p className={`${labelClass} flex items-center gap-2`}>
          <LoaderCircle size={14} className="animate-spin" />
          {t.loading}
        </p>
      ) : !user && !account.configured ? (
        <>
          <p className="text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">{t.notConfigured}</p>
          <TokenSignIn open />
        </>
      ) : !user ? (
        <SignIn />
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="size-7 rounded-full ring-1 ring-line-strong" />}
            <div className="min-w-0 flex-1 text-[calc(13px*var(--font-scale))]">
              <div className="truncate text-text">{user.name ?? user.login}</div>
              <div className="truncate text-faint">@{user.login}</div>
            </div>
            <button className={`${quietButton} flex items-center gap-1.5`} onClick={() => void logout()}>
              <LogOut size={14} strokeWidth={1.75} />
              {t.signOut}
            </button>
          </div>
          <Segmented<'clone' | 'create'>
            label={t.githubTitle}
            value={tab}
            options={[
              { value: 'clone', title: t.cloneTab },
              { value: 'create', title: t.createTab },
            ]}
            onChange={setTab}
          />
          {tab === 'clone' ? <RepoList parent={parent} onParent={setParent} /> : <CreateRepo parent={parent} onParent={setParent} />}
        </>
      )}
      {account !== null && <ClientIdSetting />}
    </ProjectDialog>
  );
}
