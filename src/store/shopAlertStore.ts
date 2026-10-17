import { create } from 'zustand'

export type FreshEnquiry = { id: string; enquiry_no: string; branch_id: string; branch_name: string; customer_name: string; created_at: string }

/** Online-shop requests for the Admin: the New counts (sidebar badge: all branches, or the branch the Admin is in), the
 * popup's requests, and which one to open (with its branch, so a branch view can switch to it). */
export const useShopAlertStore = create<{
  newCount: number
  newByBranch: Record<string, number>
  popup: FreshEnquiry[]
  focusId: string | null
  focusBranch: string | null
  setNewCount: (n: number, byBranch?: Record<string, number>) => void
  addPopup: (items: FreshEnquiry[]) => void
  clearPopup: () => void
  focus: (id: string | null, branch?: string | null) => void
}>((set) => ({
  newCount: 0,
  newByBranch: {},
  popup: [],
  focusId: null,
  focusBranch: null,
  setNewCount: (newCount, byBranch) => set(byBranch ? { newCount, newByBranch: byBranch } : { newCount }),
  addPopup: (items) => set((s) => ({ popup: [...items.filter((i) => !s.popup.some((p) => p.id === i.id)), ...s.popup].slice(0, 10) })),
  clearPopup: () => set({ popup: [] }),
  focus: (focusId, branch = null) => set({ focusId, focusBranch: focusId ? branch : null }),
}))
