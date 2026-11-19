import { selectDocState, useApp } from '../../app/store';
import { inheritedSummary } from '../../core/minecraft/parents';
import { useT } from '../../i18n';
import { dispatch } from '../actions';
import { SectionTitle, smallButton } from '../minecraft/fields';
import { notifySuccess } from '../toast';
import { getT } from '../../i18n';

const note = 'text-[calc(12px*var(--font-scale))] leading-snug text-dim';

/** Model panel: what the parent model chain provides, and buttons to show, merge or drop it. */
export function ParentSection() {
  const t = useT().modelImport.parent;
  const state = useApp((s) => selectDocState(s));
  const parent = state.java?.parent ?? '';
  if (!parent) return null;
  const summary = inheritedSummary(state);
  const merge = async () => {
    const merged = (await dispatch('minecraft.merge_parent')) as { elements: number; textures: number } | undefined;
    if (merged) notifySuccess(getT().modelImport.parent.merged(merged.elements, merged.textures));
  };
  return (
    <div className="flex flex-col gap-1.5">
      <SectionTitle>{t.section}</SectionTitle>
      {summary ? (
        <>
          <p className={note} title={summary.chain.join(' → ')}>
            {t.chain}: {summary.chain.join(' → ')}
          </p>
          {summary.builtin === 'generated' ? (
            <p className={note}>{t.generated}</p>
          ) : summary.elementsOverridden ? (
            <p className={note}>{t.overridden}</p>
          ) : (
            summary.elements > 0 && <p className={note}>{t.inheritedElements(summary.elements)}</p>
          )}
          {summary.missing.length > 0 && <p className={`${note} text-danger`}>{t.missing(summary.missing.join(', '))}</p>}
        </>
      ) : (
        <p className={note}>{t.notShown}</p>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        {summary ? (
          <button className={smallButton} onClick={() => void dispatch('minecraft.hide_parent')}>
            {t.hideAction}
          </button>
        ) : (
          <button className={smallButton} onClick={() => void dispatch('minecraft.show_parent')}>
            {t.showAction}
          </button>
        )}
        <button className={smallButton} disabled={summary?.builtin === 'generated'} onClick={() => void merge()}>
          {t.mergeAction}
        </button>
      </div>
    </div>
  );
}
