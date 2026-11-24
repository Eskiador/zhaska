import { create } from 'zustand'
import { Button } from './Button'
import { Dialog } from './overlays'

interface ConfirmRequest {
  title: string
  description?: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

const useConfirmStore = create<{ req: ConfirmRequest | null; set: (r: ConfirmRequest | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }))

/** Pide confirmación al usuario. Devuelve true si acepta. */
export function confirm(opts: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirmStore.getState().set({ ...opts, resolve }))
}

export function ConfirmHost() {
  const req = useConfirmStore((s) => s.req)
  const set = useConfirmStore((s) => s.set)
  const done = (ok: boolean) => {
    req?.resolve(ok)
    set(null)
  }
  return (
    <Dialog
      open={!!req}
      onClose={() => done(false)}
      title={req?.title}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(false)}>
            Cancelar
          </Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
            {req?.confirmLabel}
          </Button>
        </>
      }
    >
      {req?.description && <div className="selectable px-5 py-4 text-body text-fg-2">{req.description}</div>}
    </Dialog>
  )
}
