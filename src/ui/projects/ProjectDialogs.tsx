import { AlertDialog } from '@base-ui/react/alert-dialog';
import { Check, GitBranch, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { documentName, useT } from '../../i18n';
import { selectActiveDoc, useApp } from '../../app/store';
import { gitApi, type Branches } from '../../bridge/projects';
import { notifyError } from '../toast';
import { inputClass, labelClass, outlineButton, primaryButton, ProjectDialog, quietButton, dangerButton } from './dialogParts';
import { nameProblem, stemOf } from './projectModel';
import { activeProject, commit, createFolder, dirtyProjectDocs, renameEntry, saveIntoProject, switchBranch, trashEntry, useProjects } from './projectsStore';

/** New folder, rename and "save into project": one name field. */
function NamePromptDialog() {
  const t = useT();
  const prompt = useProjects((s) => s.prompt);
  const docName = useApp((s) => documentName(selectActiveDoc(s), t));
  const [value, setValue] = useState('');
  const close = () => useProjects.setState({ prompt: null });

  useEffect(() => {
    if (!prompt) return;
    if (prompt.kind === 'rename') setValue(prompt.path.split('/').pop() ?? '');
    else if (prompt.kind === 'saveInto') setValue(docName);
    else setValue('');
  }, [prompt, docName]);

  if (!prompt) return <ProjectDialog open={false} onClose={close} title="">{null}</ProjectDialog>;
  const texts = t.projects;
  const title = prompt.kind === 'newFolder' ? texts.newFolder : prompt.kind === 'rename' ? texts.rename : texts.saveInto;
  const folder = prompt.kind === 'rename' ? null : prompt.dir || texts.projectRoot;
  const problem = nameProblem(value);

  const submit = async () => {
    if (problem) return;
    close();
    if (prompt.kind === 'newFolder') await createFolder(prompt.dir, value);
    else if (prompt.kind === 'rename') await renameEntry(prompt.path, value, prompt.isDir);
    else await saveIntoProject(prompt.dir, value);
  };

  return (
    <ProjectDialog
      open
      onClose={close}
      title={title}
      footer={
        <>
          <button className={`${quietButton} mr-auto`} onClick={close}>
            {t.dialogs.cancel}
          </button>
          <button className={primaryButton} disabled={problem !== null} onClick={() => void submit()}>
            {prompt.kind === 'saveInto' ? t.dialogs.save : texts.ok}
          </button>
        </>
      }
    >
      {folder && <p className={labelClass}>{texts.inFolder(folder)}</p>}
      <input
        autoFocus
        aria-label={t.common.name}
        className={inputClass}
        value={value}
        onFocus={(e) => {
          // Select the name without its extension, like file managers do.
          const end = prompt.kind === 'rename' && !prompt.isDir ? stemOf(e.currentTarget.value).length : e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(0, end);
        }}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      {problem === 'invalid' && <p className="text-[calc(12px*var(--font-scale))] text-danger">{texts.invalidName}</p>}
      {prompt.kind === 'saveInto' && <p className={labelClass}>{texts.saveIntoHint}</p>}
    </ProjectDialog>
  );
}

function TrashDialog() {
  const t = useT();
  const path = useProjects((s) => s.trashPath);
  const close = () => useProjects.setState({ trashPath: null });
  return (
    <AlertDialog.Root open={path !== null} onOpenChange={(next) => !next && close()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-40 bg-black/45" />
        <AlertDialog.Popup className="anim-pop fixed top-[24vh] left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-line-strong bg-overlay p-5 shadow-pop">
          <AlertDialog.Title className="font-display text-[calc(15px*var(--font-scale))] font-semibold text-text">{t.projects.trashTitle}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-[calc(13px*var(--font-scale))] leading-relaxed text-dim">{t.projects.trashText(path ?? '')}</AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Close className={`${quietButton} mr-auto`}>{t.dialogs.cancel}</AlertDialog.Close>
            <button
              className={dangerButton}
              onClick={() => {
                close();
                if (path) void trashEntry(path);
              }}
            >
              {t.projects.trash}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

const statusOrder = ['conflicted', 'modified', 'renamed', 'typechange', 'new', 'deleted'];

function CommitDialog() {
  const t = useT();
  const texts = t.projects;
  const open = useProjects((s) => s.commitOpen);
  const status = useProjects((s) => s.status);
  const busy = useProjects((s) => s.busy);
  const [message, setMessage] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const files = [...(status?.files ?? [])].sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || a.path.localeCompare(b.path));
  const dirty = open ? dirtyProjectDocs() : [];
  const close = () => useProjects.setState({ commitOpen: false });

  useEffect(() => {
    if (open) setChosen(new Set(useProjects.getState().status?.files.map((f) => f.path) ?? []));
  }, [open]);

  const all = files.length > 0 && files.every((f) => chosen.has(f.path));
  const run = async (andPush: boolean) => {
    const list = all ? undefined : files.filter((f) => chosen.has(f.path)).map((f) => f.path);
    if (await commit(message, list, andPush)) {
      setMessage('');
      close();
    }
  };
  const canCommit = message.trim().length > 0 && chosen.size > 0 && busy === null;
  const toggle = (path: string) => {
    const next = new Set(chosen);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setChosen(next);
  };

  return (
    <ProjectDialog
      open={open}
      onClose={close}
      title={texts.commitTitle}
      width="32rem"
      footer={
        <>
          <button className={`${quietButton} mr-auto`} onClick={close}>
            {t.dialogs.cancel}
          </button>
          <button className={outlineButton} disabled={!canCommit} onClick={() => void run(false)}>
            {texts.commit}
          </button>
          <button className={primaryButton} disabled={!canCommit || !status?.remote} onClick={() => void run(true)}>
            {busy === 'commit' || busy === 'push' ? <LoaderCircle size={14} className="animate-spin" /> : texts.commitAndPush}
          </button>
        </>
      }
    >
      {dirty.length > 0 && <p className="rounded-md bg-danger/10 px-3 py-2 text-[calc(12.5px*var(--font-scale))] text-danger">{texts.unsavedDocs(dirty)}</p>}
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>{texts.message}</span>
        <textarea
          autoFocus
          rows={3}
          className={`${inputClass} h-auto resize-none py-2`}
          placeholder={texts.messagePlaceholder}
          value={message}
          onChange={(e) => setMessage(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && canCommit) void run(false);
          }}
        />
      </label>
      <div className="flex items-center justify-between">
        <span className={labelClass}>{texts.filesToCommit(chosen.size, files.length)}</span>
        <button className="text-[calc(12.5px*var(--font-scale))] text-accent hover:underline" onClick={() => setChosen(all ? new Set() : new Set(files.map((f) => f.path)))}>
          {all ? texts.selectNone : texts.selectAll}
        </button>
      </div>
      <ul className="flex max-h-64 flex-col gap-px overflow-y-auto rounded-md bg-ink p-1 ring-1 ring-line ring-inset">
        {files.map((file) => (
          <li key={file.path}>
            <label className="flex h-7 cursor-pointer items-center gap-2 rounded-[5px] px-2 text-[calc(12.5px*var(--font-scale))] text-dim hover:bg-raised hover:text-text">
              <input type="checkbox" className="accent-[var(--accent)]" checked={chosen.has(file.path)} onChange={() => toggle(file.path)} />
              <span className="min-w-0 flex-1 truncate" title={file.path}>
                {file.path}
              </span>
              <span className={`shrink-0 text-[calc(11.5px*var(--font-scale))] ${file.status === 'conflicted' || file.status === 'deleted' ? 'text-danger' : file.status === 'new' ? 'text-ok' : 'text-accent'}`}>
                {texts.gitStatus[file.status]}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </ProjectDialog>
  );
}

function BranchDialog() {
  const t = useT();
  const texts = t.projects;
  const open = useProjects((s) => s.branchOpen);
  const busy = useProjects((s) => s.busy);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [loading, setLoading] = useState(false);
  const close = () => useProjects.setState({ branchOpen: false });

  useEffect(() => {
    const project = activeProject();
    if (!open || !project) return;
    let current = true;
    setLoading(true);
    gitApi
      .branches(project.id)
      .then((list) => current && setBranches(list))
      .catch(notifyError)
      // Then ask the remote for branches the others created meanwhile.
      .then(() => (project.remote ? gitApi.branches(project.id, true) : null))
      .then((list) => current && list && setBranches(list))
      .catch(notifyError)
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [open]);

  const choose = async (branch: string) => {
    close();
    await switchBranch(branch);
  };
  const row = (name: string, remote: boolean) => {
    const current = branches?.current === name;
    return (
      <li key={`${remote}-${name}`}>
        <button
          disabled={current || busy !== null}
          className="flex h-7 w-full items-center gap-2 rounded-[5px] px-2 text-left text-[calc(12.5px*var(--font-scale))] text-dim hover:bg-raised hover:text-text disabled:pointer-events-none"
          onClick={() => void choose(name)}
        >
          <span className="flex w-4 justify-center">{current ? <Check size={14} className="text-accent" /> : <GitBranch size={13} strokeWidth={1.75} />}</span>
          <span className={`min-w-0 flex-1 truncate ${current ? 'text-text' : ''}`}>{name}</span>
          {remote && <span className="text-[calc(11.5px*var(--font-scale))] text-faint">{texts.remoteBranch}</span>}
        </button>
      </li>
    );
  };

  return (
    <ProjectDialog open={open} onClose={close} title={texts.branches}>
      {loading && !branches && <p className={labelClass}>{texts.loading}</p>}
      {branches && (
        <ul className="flex max-h-72 flex-col gap-px overflow-y-auto">
          {branches.local.map((name) => row(name, false))}
          {branches.remote.map((name) => row(name, true))}
        </ul>
      )}
      {loading && branches && <p className="text-[calc(12px*var(--font-scale))] text-faint">{texts.fetching}</p>}
      <p className="text-[calc(12px*var(--font-scale))] leading-relaxed text-faint">{texts.switchHint}</p>
    </ProjectDialog>
  );
}

export function ProjectDialogs() {
  return (
    <>
      <NamePromptDialog />
      <TrashDialog />
      <CommitDialog />
      <BranchDialog />
    </>
  );
}
