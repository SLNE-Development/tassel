import { useState } from 'react';
import { selectDocState, useApp } from '../../app/store';
import { useT } from '../../i18n';
import { Segmented } from '../controls';
import { ElementPanel } from './ElementPanel';
import { ModelSettings, TexturesPanel } from './ModelPanel';

type Tab = 'element' | 'model' | 'textures';

/** The properties panel of a Minecraft document: the active element, the model's settings, its textures. */
export function MinecraftProperties({ activeId }: { activeId: string | null }) {
  const isElement = useApp((s) => (activeId ? selectDocState(s).objects[activeId]?.cuboid !== undefined : false));
  const [tab, setTab] = useState<Tab>('element');
  const t = useT().mc;
  // Without an active element the first tab has nothing to show, so the model is shown.
  const shown: Tab = tab === 'element' && !isElement ? 'model' : tab;
  return (
    <div className="flex flex-col gap-3 px-3 pb-4">
      <Segmented<Tab>
        label={t.panel.label}
        value={shown}
        options={[
          { value: 'element', title: t.panel.element },
          { value: 'model', title: t.panel.model },
          { value: 'textures', title: t.panel.textures },
        ]}
        onChange={setTab}
      />
      {shown === 'element' && activeId && <ElementPanel key={activeId} id={activeId} />}
      {shown === 'model' && <ModelSettings />}
      {shown === 'textures' && <TexturesPanel />}
    </div>
  );
}
