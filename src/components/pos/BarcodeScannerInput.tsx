import React, { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Camera, X, AlertCircle, Sparkles, ScanLine, SwitchCamera } from 'lucide-react'
import { BrowserMultiFormatReader, type IScannerControls } from '@zxing/browser'
import { barcodeService } from '../../services/barcodeService'
import { BRAND_EN } from '../../lib/brand'
import { normalizeBarcode } from '../../lib/barcode'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import type { PosBranch } from '../../store/store'

export interface ScannedItemPayload {
  product_id: number
  variant_id?: string | null
  product_name: string
  name_ta?: string
  variant_name?: string
  price: number
  offer_price?: number
  stock: number
  barcode: string
  unit?: string
  image_url?: string
  category?: string
}

export interface BarcodeScannerInputProps {
  branch: PosBranch
  onItemScanned: (item: ScannedItemPayload) => void
  disabled?: boolean
}

export const BarcodeScannerInput: React.FC<BarcodeScannerInputProps> = ({
  branch,
  onItemScanned,
  disabled = false,
}) => {
  const [manualCode, setManualCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [lastScannedName, setLastScannedName] = useState('')

  // Camera scanner state
  const [isCameraOpen, setIsCameraOpen] = useState(false)
  useBodyScrollLock(isCameraOpen)
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')
  const videoRef = useRef<HTMLVideoElement>(null)
  const readerRef = useRef<BrowserMultiFormatReader | null>(null)
  const controlsRef = useRef<IScannerControls | null>(null)
  const activeStreamRef = useRef<MediaStream | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Explicit camera stop helper ensuring ALL camera hardware resources & tracks are released
  const stopCamera = useCallback(() => {
    if (controlsRef.current) {
      try {
        controlsRef.current.stop()
      } catch (e) {
        console.warn('Could not stop ZXing scanner controls:', e)
      }
      controlsRef.current = null
    }

    if (activeStreamRef.current) {
      try {
        activeStreamRef.current.getTracks().forEach((track) => {
          track.stop()
          track.enabled = false
        })
      } catch (e) {
        console.warn('Could not stop active stream tracks:', e)
      }
      activeStreamRef.current = null
    }

    if (videoRef.current && videoRef.current.srcObject) {
      try {
        const stream = videoRef.current.srcObject as MediaStream
        stream.getTracks().forEach((track) => {
          track.stop()
          track.enabled = false
        })
        videoRef.current.srcObject = null
      } catch (e) {
        console.warn('Could not stop video element stream:', e)
      }
    }

    if (readerRef.current) {
      readerRef.current = null
    }
  }, [])

  const handleCloseCamera = useCallback(() => {
    stopCamera()
    setIsCameraOpen(false)
  }, [stopCamera])

  // Hardware Scanner buffer (tracking keystroke timing)
  const bufferRef = useRef<{ code: string; lastTime: number; targetInput: HTMLInputElement | HTMLTextAreaElement | null }>({
    code: '',
    lastTime: 0,
    targetInput: null,
  })

  // Audio Beep generator via Web Audio API (muted by default - only plays on success)
  const playBeep = (isSuccess = true) => {
    // Only play beep on success to avoid unnecessary error sounds
    if (!isSuccess) return

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!AudioCtx) return
      const ctx = new AudioCtx()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(1800, ctx.currentTime)
      gain.gain.setValueAtTime(0.1, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.08)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      osc.stop(ctx.currentTime + 0.08)
    } catch {
      // Audio context might be restricted before first user interaction
    }
  }

  // Handle scanned barcode lookup
  const processBarcode = useCallback(async (barcodeVal: string) => {
    const clean = normalizeBarcode(barcodeVal)
    if (!clean) return

    setLoading(true)
    setErrorMsg('')

    try {
      const record = await barcodeService.lookupBarcode(clean, branch)

      if (!record || !record.product) {
        playBeep(false)
        setErrorMsg(`Barcode "${clean}" not recognized in ${BRAND_EN} catalog`)
        return
      }

      const prod = record.product
      const varnt = record.variant

      const effectiveStock = varnt ? (Number(varnt.stock) || 0) : 999

      const price = varnt?.price ? Number(varnt.price) : Number(prod.price)

      const payload: ScannedItemPayload = {
        product_id: record.product_id,
        variant_id: record.variant_id || null,
        product_name: prod.name,
        name_ta: prod.name_ta,
        variant_name: varnt?.variant_name,
        price: price,
        offer_price: prod.offer_price ? Number(prod.offer_price) : undefined,
        stock: effectiveStock,
        barcode: clean,
        image_url: prod.image_url,
        category: prod.category,
      }

      playBeep(true)
      setLastScannedName(`${prod.name}${varnt?.variant_name ? ` (${varnt.variant_name})` : ''}`)
      onItemScanned(payload)
      setManualCode('')

      setTimeout(() => setLastScannedName(''), 3500)
    } catch (err) {
      console.error('Barcode lookup failed:', err)
      playBeep(false)
      setErrorMsg((err as Error).message || 'Failed to scan barcode')
    } finally {
      setLoading(false)
    }
  }, [branch, onItemScanned])

  // Non-Blocking HID Keystroke Interceptor
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now()
      const diff = now - bufferRef.current.lastTime
      const target = e.target as HTMLElement
      const isInputField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      if (e.key === 'Enter') {
        const buffered = bufferRef.current.code
        // If rapid keystrokes (< 45ms average) accumulated >= 4 characters
        if (buffered.length >= 4 && diff < 150) {
          e.preventDefault()
          e.stopPropagation()

          // If the cashier was focused in an input field, strip the injected barcode text from that field
          if (isInputField && bufferRef.current.targetInput) {
            const inputEl = bufferRef.current.targetInput
            if (inputEl.value && inputEl.value.endsWith(buffered)) {
              inputEl.value = inputEl.value.slice(0, -buffered.length)
              // Dispatch input event so React state updates
              inputEl.dispatchEvent(new Event('input', { bubbles: true }))
            }
          }

          bufferRef.current = { code: '', lastTime: 0, targetInput: null }
          void processBarcode(buffered)
          return
        }

        bufferRef.current = { code: '', lastTime: 0, targetInput: null }
        return
      }

      // Printable single character
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (diff > 45) {
          // Slow typing cadence (human typing): start fresh buffer
          bufferRef.current = {
            code: e.key,
            lastTime: now,
            targetInput: isInputField ? (target as HTMLInputElement | HTMLTextAreaElement) : null,
          }
        } else {
          // Rapid typing cadence (< 45ms): hardware barcode scanner burst
          bufferRef.current.code += e.key
          bufferRef.current.lastTime = now
          if (isInputField) {
            bufferRef.current.targetInput = target as HTMLInputElement | HTMLTextAreaElement
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [processBarcode])

  // Touch Device Detection Helper
  const isTouchDevice = () => {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0
  }

  // Handle Input Bar Click on Touch Devices
  const handleInputBarClick = () => {
    if (isTouchDevice()) {
      setIsCameraOpen(true)
    }
  }

  // Camera scanner lifecycle & decoding
  useEffect(() => {
    if (!isCameraOpen) {
      stopCamera()
      return
    }

    const videoElement = videoRef.current
    if (!videoElement) return

    let isMounted = true
    const reader = new BrowserMultiFormatReader()
    readerRef.current = reader

    // Enumerate devices in the background for camera picker without disrupting current stream
    BrowserMultiFormatReader.listVideoInputDevices()
      .then((devices) => {
        if (!isMounted) return
        setVideoDevices(devices)
        if (devices.length > 0 && !selectedDeviceId) {
          const backCam = devices.find((d) =>
            d.label.toLowerCase().includes('back') ||
            d.label.toLowerCase().includes('rear') ||
            d.label.toLowerCase().includes('environment')
          )
          // Store without immediately re-triggering if default stream is fine
          if (backCam) {
            setSelectedDeviceId(backCam.deviceId)
          }
        }
      })
      .catch((err) => {
        console.warn('Could not enumerate cameras:', err)
      })

    // Start decoding immediately using selected device or default environment camera
    const decodePromise = reader.decodeFromVideoDevice(
      selectedDeviceId || undefined,
      videoElement,
      (result, _err) => {
        if (!isMounted) return
        if (result) {
          const text = result.getText()
          if (text) {
            stopCamera()
            setIsCameraOpen(false)
            void processBarcode(text)
          }
        }
      }
    )

    decodePromise
      .then((controls) => {
        if (!isMounted) {
          controls.stop()
        } else {
          controlsRef.current = controls
          if (videoElement.srcObject) {
            activeStreamRef.current = videoElement.srcObject as MediaStream
          }
        }
      })
      .catch((err) => {
        if (!isMounted) return
        console.error('Camera barcode reader error:', err)
        setErrorMsg('Camera access denied or unavailable')
      })

    return () => {
      isMounted = false
      stopCamera()
    }
  }, [isCameraOpen, selectedDeviceId, processBarcode, stopCamera])

  // Listen for Escape key to close camera
  useEffect(() => {
    if (!isCameraOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleCloseCamera()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isCameraOpen, handleCloseCamera])

  return (
    <div className="w-full space-y-1.5">
      <div className="flex items-center gap-2">
        {/* Scanner Search Box */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (manualCode.trim()) void processBarcode(manualCode.trim())
          }}
          className="relative flex-1 flex items-center"
        >
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#D4AF37] flex items-center pointer-events-none">
            <ScanLine size={18} />
          </div>

          <input
            ref={inputRef}
            type="text"
            placeholder="Scan barcode with machine, camera, or type code..."
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            disabled={disabled || loading}
            className="w-full pl-10 pr-24 py-3 rounded-2xl border-2 border-[#E8D399] bg-[#FBFAF6] font-bold text-sm text-black placeholder:text-gray-400 outline-none focus:border-[#7A1220] focus:bg-white shadow-xs transition-all"
          />

          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
            {manualCode && (
              <button
                type="submit"
                disabled={loading}
                className="px-3 py-1.5 rounded-xl bg-[#7A1220] text-[#D4AF37] text-xs font-black hover:bg-[#1A1A1A] cursor-pointer"
              >
                {loading ? '...' : 'Add'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsCameraOpen(true)}
              title="Scan with Camera"
              className="p-2 rounded-xl bg-white border border-[#E8D399] text-gray-700 hover:text-black hover:border-black transition-all cursor-pointer shadow-xs"
            >
              <Camera size={16} />
            </button>
          </div>
        </form>
      </div>

      {/* Success Notification Pill */}
      {lastScannedName && (
        <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 bg-emerald-50 border border-emerald-300 px-3 py-1 rounded-full animate-in fade-in duration-150">
          <Sparkles size={13} className="text-emerald-600" />
          Added: <span className="font-black text-black">{lastScannedName}</span> (+1 qty)
        </div>
      )}

      {/* Error Notification Pill */}
      {errorMsg && (
        <div className="inline-flex items-center gap-1.5 text-xs font-bold text-rose-800 bg-rose-50 border border-rose-300 px-3 py-1 rounded-full animate-in fade-in duration-150">
          <AlertCircle size={13} className="text-rose-600" />
          {errorMsg}
        </div>
      )}

      {/* Instant Webcam Scanner Modal */}
      {isCameraOpen && createPortal(
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseCamera()
          }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
        >
          <div className="bg-[#7A1220] rounded-3xl max-w-md w-full border border-[#D4AF37] shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-200 text-white">
            <div className="px-5 py-4 border-b border-[#D4AF37]/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera size={18} className="text-[#D4AF37]" />
                <span className="font-black text-sm text-white">Camera Barcode Scanner</span>
              </div>
              <button
                onClick={handleCloseCamera}
                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-white cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-4 flex flex-col items-center">
              <div className="relative w-full aspect-square max-w-[320px] rounded-2xl overflow-hidden border-2 border-[#D4AF37] bg-black">
                <video ref={videoRef} className="w-full h-full object-cover" />
                {/* Visual Laser Reticle Guide */}
                <div className="absolute inset-x-6 top-1/2 -translate-y-1/2 h-0.5 bg-red-500 shadow-[0_0_12px_red] animate-pulse" />
                <div className="absolute inset-6 border-2 border-dashed border-[#D4AF37]/60 rounded-xl pointer-events-none" />
              </div>

              {/* Camera Switcher if multiple devices */}
              {videoDevices.length > 1 && (
                <div className="mt-3 flex items-center gap-2 w-full max-w-[320px]">
                  <SwitchCamera size={15} className="text-[#D4AF37] shrink-0" />
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    className="w-full bg-[#1A1A1A] border border-gray-700 text-xs font-bold text-white rounded-lg px-2 py-1.5 outline-none focus:border-[#D4AF37]"
                  >
                    {videoDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Camera ${d.deviceId.slice(0, 6)}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <p className="text-xs text-[#D4AF37] mt-3 text-center font-bold">
                Align the red line with the barcode sticker on the product
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
