import { create } from 'zustand'
import { alarmSound } from '../lib/alarmAudio'

export interface LowStockItem {
  id: string | number
  name: string
  variantName?: string
  stock: number
  alertThreshold: number
  barcode?: string
  category?: string
}

interface AlarmState {
  lowStockItems: LowStockItem[]
  isAlarmActive: boolean
  silencedItemIds: Set<string | number>
  setLowStockItems: (items: LowStockItem[]) => void
  silenceAlarm: () => void
  resetSilencedState: () => void
}

export const useAlarmStore = create<AlarmState>((set, get) => ({
  lowStockItems: [],
  isAlarmActive: false,
  silencedItemIds: new Set<string | number>(),

  setLowStockItems: (items) => {
    const { silencedItemIds, lowStockItems: previousItems, isAlarmActive: wasAlarmActive } = get()

    // Alarm triggers only if there is at least one low-stock item that has not been acknowledged
    const hasUnsilencedLowStock = items.some(
      (item) => !silencedItemIds.has(String(item.id)) && !silencedItemIds.has(item.id)
    )

    // Check if the items list has actually changed (comparing IDs)
    const previousIds = previousItems.map(i => String(i.id)).sort().join(',')
    const currentIds = items.map(i => String(i.id)).sort().join(',')
    const itemsChanged = previousIds !== currentIds

    if (items.length > 0 && hasUnsilencedLowStock) {
      // Only start/restart alarm if items have changed or alarm wasn't previously active
      if (itemsChanged || !wasAlarmActive) {
        alarmSound.startAlert()
        if (!wasAlarmActive) {
          console.log('[Low Stock Alert] New low stock items detected:', items.length)
        }
      }
      set({ lowStockItems: items, isAlarmActive: true })
    } else {
      // If no items or all items are acknowledged/silenced, ensure alert is stopped
      if (wasAlarmActive) {
        alarmSound.stopAlert()
      }
      set({ lowStockItems: items, isAlarmActive: false })
      if (items.length === 0) {
        set({ silencedItemIds: new Set() })
      }
    }
  },

  silenceAlarm: () => {
    const currentItemIds = get().lowStockItems.map((i) => String(i.id))
    alarmSound.stopAlert()
    set({
      isAlarmActive: false,
      silencedItemIds: new Set(currentItemIds),
    })
  },

  resetSilencedState: () => {
    set({ silencedItemIds: new Set() })
  },
}))
