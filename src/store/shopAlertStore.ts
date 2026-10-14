import { create } from 'zustand'

export type FreshEnquiry = { id: string; enquiry_no: string; branch_id: string; branch_name: string; customer_name: string; created_at: string }

/** Online-shop requests for the Admin: the New count (sidebar badge), the popup's requests, and which one to open. */
export const useShopAlertStore = create<{
  newCount: number
  popup: FreshEnquiry[]
  focusId: string | null
  setNewCount: (n: number) => void
  addPopup: (items: FreshEnquiry[]) => void
  clearPopup: () => void
  focus: (id: string | null) => void
}>((set) => ({
  newCount: 0,
  popup: [],
  focusId: null,
  setNewCount: (newCount) => set({ newCount }),
  addPopup: (items) => set((s) => ({ popup: [...items.filter((i) => !s.popup.some((p) => p.id === i.id)), ...s.popup].slice(0, 10) })),
  clearPopup: () => set({ popup: [] }),
  focus: (focusId) => set({ focusId }),
}))
