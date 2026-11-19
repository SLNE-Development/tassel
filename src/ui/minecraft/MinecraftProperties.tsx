import { useEffect, useState } from 'react';
import { useFactorySelection } from '../../app/factorySelection';
import { selectDocState, useApp } from '../../app/store';
import { useT } from '../../i18n';
import { Segmented } from '../controls';
import { useIsFactory } from '../format';
import { MachinePanel } from '../factory/MachinePanel';
import { PortPanel } from '../factory/PortPanel';
import { ElementPanel } from './ElementPanel';
import { ModelSettings, TexturesPanel } from './ModelPanel';

type Tab = 'element' | 'machine' | 'ports' | 'model' | 'textures';

/** The properties panel of a Minecraft document: the active element, the model's settings, its textures. */
export function MinecraftProperties({ activeId }: { activeId: string | null }) {
  const isElement = useApp((s) => (activeId ? selectDocState(s).objects[activeId]?.cuboid !== undefined : false));
  const [tab, setTab] = useState<Tab>('element');
  const factory = useIsFactory();
  const t = useT().mc;
  const tf = useT().factory.panel;
  const portUid = useFactorySelection((s) => s.portUid);
  // Selecting a port (in the viewport or the outliner) shows its editor.
  useEffect(() => {
    if (portUid) setTab('ports');
  }, [portUid]);
  // Without an active element the first tab has nothing to show, so the model is shown.
  let shown: Tab = tab === 'element' && !isElement ? (factory ? 'machine' : 'model') : tab;
  // The machine and port tabs exist in factory models only.
  if (!factory && (shown === 'machine' || shown === 'ports')) shown = 'model';
  return (
    <div className="flex flex-col gap-3 px-3 pb-4">
      <Segmented<Tab>
        label={t.panel.label}
        value={shown}
        options={[
          { value: 'element', title: t.panel.element },
          ...(factory ? [{ value: 'machine' as const, title: tf.machine }, { value: 'ports' as const, title: tf.ports }] : []),
          { value: 'model', title: t.panel.model },
          { value: 'textures', title: t.panel.textures },
        ]}
        onChange={setTab}
      />
      {shown === 'element' && activeId && <ElementPanel key={activeId} id={activeId} />}
      {shown === 'machine' && <MachinePanel />}
      {shown === 'ports' && <PortPanel />}
      {shown === 'model' && <ModelSettings />}
      {shown === 'textures' && <TexturesPanel />}
    </div>
  );
}
