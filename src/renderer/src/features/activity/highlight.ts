import { create } from 'zustand'

/** Paso resaltado en el panel de actividad al pulsar un chip del chat. */
export const useHighlight = create<{ stepId: string | null; n: number; flash: (id: string) => void }>((set, get) => ({
  stepId: null,
  n: 0,
  flash: (stepId) => set({ stepId, n: get().n + 1 }),
}))
