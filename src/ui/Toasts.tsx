import { Toast } from '@base-ui/react/toast';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

const icons = {
  error: <CircleAlert size={16} className="text-danger" />,
  success: <CircleCheck size={16} className="text-ok" />,
  info: <Info size={16} className="text-dim" />,
};

export function Toasts() {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-3 bottom-9.5 z-70 flex w-80 max-w-[calc(100vw-1.5rem)] flex-col-reverse gap-2 outline-none">
        {toasts.map((toast) => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            className="anim-toast flex items-start gap-2.5 rounded-lg border border-line-strong bg-overlay py-2.5 pr-2 pl-3 shadow-pop data-[ending-style]:opacity-0 data-[ending-style]:transition-opacity"
          >
            <span className="mt-px shrink-0">{icons[toast.type as keyof typeof icons] ?? icons.info}</span>
            <div className="min-w-0 flex-1">
              <Toast.Title className="text-[13px] font-medium text-text" />
              <Toast.Description className="mt-0.5 text-[12.5px] leading-snug break-words text-dim select-text" />
            </div>
            <Toast.Close aria-label="Schließen" className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-raised hover:text-text">
              <X size={13} />
            </Toast.Close>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
