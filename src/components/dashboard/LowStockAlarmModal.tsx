import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Volume2, VolumeX, Package, ChevronRight } from 'lucide-react'
import { useAlarmStore } from '../../store/alarmStore'
import { alarmSound } from '../../lib/alarmAudio'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'

export const LowStockAlarmModal: React.FC = () => {
  const isAlarmActive = useAlarmStore((state) => state.isAlarmActive)
  const lowStockItems = useAlarmStore((state) => state.lowStockItems)
  const silenceAlarm = useAlarmStore((state) => state.silenceAlarm)
  const [isAudioBlocked, setIsAudioBlocked] = useState(() => alarmSound.isBlocked())

  useBodyScrollLock(isAlarmActive && lowStockItems.length > 0)

  useEffect(() => {
    setIsAudioBlocked(alarmSound.isBlocked())
    const unsubscribe = alarmSound.subscribe(() => {
      setIsAudioBlocked(alarmSound.isBlocked())
    })
    return unsubscribe
  }, [])

  const handleWakeAudio = () => {
    void alarmSound.unlock()
  }

  if (!isAlarmActive || lowStockItems.length === 0) return null

  return createPortal(
    <div
      onClick={handleWakeAudio}
      onTouchStart={handleWakeAudio}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/75 backdrop-blur-xs p-2 sm:p-4 overflow-hidden animate-in fade-in duration-200"
    >
      <div
        onClick={(e) => {
          e.stopPropagation()
          handleWakeAudio()
        }}
        className="bg-white rounded-2xl sm:rounded-3xl max-w-lg w-full shadow-2xl overflow-hidden border-2 border-red-500 animate-in zoom-in-95 flex flex-col max-h-[100dvh] sm:max-h-[90vh]"
      >
        {/* Pulsing Alarm Header */}
        <div className="bg-gradient-to-r from-red-600 via-rose-600 to-amber-600 text-white px-5 py-4 flex items-center justify-between shrink-0 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-white/20 flex items-center justify-center animate-bounce">
              <AlertTriangle className="w-5 h-5 text-yellow-200" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-yellow-300 animate-ping" />
                <h3 className="font-black text-sm tracking-wide">
                  Low Stock Alarm Active
                </h3>
              </div>
              <p className="text-[11px] text-white/90 font-semibold">
                {lowStockItems.length} {lowStockItems.length === 1 ? 'item requires' : 'items require'} immediate restocking
              </p>
            </div>
          </div>

          {isAudioBlocked ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                handleWakeAudio()
              }}
              onTouchStart={(e) => {
                e.stopPropagation()
                handleWakeAudio()
              }}
              className="flex items-center gap-1.5 bg-yellow-300 hover:bg-yellow-400 text-yellow-950 px-3 py-1.5 rounded-full text-[11px] font-black tracking-wide animate-bounce shadow-md cursor-pointer transition-transform active:scale-95 shrink-0"
              title="Tap to enable sound on iOS"
            >
              <Volume2 className="w-3.5 h-3.5 text-yellow-950 animate-pulse" />
              <span>Tap for Sound 🔊</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 bg-white/20 px-2.5 py-1 rounded-full text-[10px] font-black tracking-wide animate-pulse shrink-0">
              <Volume2 className="w-3.5 h-3.5" />
              <span>Alarm Sounding</span>
            </div>
          )}
        </div>

        {/* Notice Banner if Mobile Audio Autoplay Was Suspended */}
        {isAudioBlocked && (
          <div
            onClick={(e) => {
              e.stopPropagation()
              handleWakeAudio()
            }}
            className="px-5 py-2.5 bg-amber-100 border-b border-amber-200 flex items-center justify-between text-xs text-amber-950 cursor-pointer hover:bg-amber-200/80 transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0 pr-2">
              <Volume2 className="w-4 h-4 text-amber-700 animate-pulse shrink-0" />
              <span className="font-bold text-[11px] truncate">
                Mobile browser sound paused. Tap here to enable audio!
              </span>
            </div>
            <span className="bg-amber-800 text-white text-[10px] px-2.5 py-0.5 rounded-full font-black uppercase shrink-0">
              Enable Sound
            </span>
          </div>
        )}

        {/* Alarm Details Notice */}
        <div className="px-5 py-3 bg-red-50 border-b border-red-100 flex items-center justify-between text-xs text-red-900">
          <p className="font-medium text-[11px]">
            The audible alarm and visual alert will sound until acknowledged.
          </p>
          <span className="font-bold text-[11px] bg-red-200/80 px-2 py-0.5 rounded-lg">
            Item Limits Active
          </span>
        </div>

        {/* Scrollable Itemized Depleted Products List */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-2.5 flex-1 min-h-0 bg-[#FAFAFA]">
          {lowStockItems.map((item) => {
            const isOutOfStock = item.stock <= 0
            return (
              <div
                key={item.id}
                className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between gap-3 ${
                  isOutOfStock
                    ? 'bg-red-50/80 border-red-200 text-red-950'
                    : 'bg-amber-50/80 border-amber-200 text-amber-950'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0 flex-1">
                  <div
                    className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                      isOutOfStock ? 'bg-red-200/70 text-red-700' : 'bg-amber-200/70 text-amber-800'
                    }`}
                  >
                    <Package className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="font-bold text-xs text-gray-900 truncate">
                      {item.name}
                    </h4>
                    {item.variantName && (
                      <p className="text-[11px] font-semibold text-gray-600">
                        Size / Variant: <span className="font-bold text-gray-900">{item.variantName}</span>
                      </p>
                    )}
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <div
                    className={`inline-block px-2.5 py-1 rounded-xl text-xs font-black ${
                      isOutOfStock
                        ? 'bg-red-600 text-white shadow-xs'
                        : 'bg-amber-600 text-white shadow-xs'
                    }`}
                  >
                    {item.stock} in Stock
                  </div>
                  <p className="text-[10px] text-gray-500 font-semibold mt-0.5">
                    Alert limit: {item.alertThreshold}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Footer with Silence & Acknowledge CTA */}
        <div className="p-4 sm:p-5 border-t border-gray-200 bg-white flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0 pb-[max(1rem,calc(env(safe-area-inset-bottom)+0.75rem))]">
          <div className="flex items-center gap-2 text-gray-500 text-[11px] font-semibold">
            <VolumeX className="w-4 h-4 text-red-500" />
            <span>Silences sound until next new low-stock item</span>
          </div>

          <button
            type="button"
            onClick={silenceAlarm}
            className="w-full sm:w-auto h-11 px-6 rounded-2xl bg-gradient-to-r from-red-600 to-rose-700 hover:from-red-700 hover:to-rose-800 text-white text-xs font-black tracking-wide shadow-lg hover:shadow-xl transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98]"
          >
            <VolumeX className="w-4 h-4" />
            <span>Silence Alarm &amp; Acknowledge</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
