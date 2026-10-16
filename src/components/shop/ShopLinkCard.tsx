import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, MessageCircle } from 'lucide-react'
import qrcode from 'qrcode-generator'
import { shopLink, whatsappShareUrl } from '../../lib/shopLink'

const QR_PX = 640 // drawn large, shown small: the downloaded PNG stays sharp when printed

/** Top of the Admin "Online Shop" screen: the customer link, copy / WhatsApp share, and a QR code to download. */
export default function ShopLinkCard() {
  const link = useMemo(() => shopLink(window.location.origin), [])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const qr = qrcode(0, 'M')
    qr.addData(link)
    qr.make()
    const n = qr.getModuleCount()
    const quiet = 4 // modules of white border so phone cameras read it
    const cell = QR_PX / (n + quiet * 2)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, QR_PX, QR_PX)
    ctx.fillStyle = '#111111'
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(Math.floor((c + quiet) * cell), Math.floor((r + quiet) * cell), Math.ceil(cell), Math.ceil(cell))
      }
    }
  }, [link])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      // older browsers / no clipboard permission
      const ta = document.createElement('textarea')
      ta.value = link
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const downloadPng = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'take250-shop-qr.png'
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[#E8D399] bg-white p-3 sm:flex-row sm:items-center sm:p-4 shadow-sm" data-testid="shop-link-card">
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-[11px] font-black uppercase tracking-[0.18em] text-[#6B7280]">Customer link</p>
        <p className="break-all rounded-xl bg-[#FBFAF6] px-3 py-2 text-sm font-black text-[#111111]" data-testid="shop-link">{link}</p>
        <p className="text-[11px] font-semibold text-[#6B7280]">Send this link to customers.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1.5 rounded-xl bg-[#111111] px-4 py-2 text-[13px] font-bold text-white cursor-pointer" data-testid="shop-link-copy">
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy link'}
          </button>
          <a href={whatsappShareUrl(link)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-[#25D366] px-4 py-2 text-[13px] font-bold text-white" data-testid="shop-link-whatsapp">
            <MessageCircle size={14} /> Share on WhatsApp
          </a>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-center gap-2">
        <canvas ref={canvasRef} width={QR_PX} height={QR_PX} className="h-36 w-36 rounded-lg border border-[#E5E7EB]" aria-label={`QR code for ${link}`} role="img" data-testid="shop-link-qr" />
        <button type="button" onClick={downloadPng} className="inline-flex items-center gap-1.5 rounded-xl border border-[#E5E7EB] bg-white px-3 py-1.5 text-[12px] font-bold text-[#111111] cursor-pointer" data-testid="shop-link-qr-download">
          <Download size={13} /> Download PNG
        </button>
      </div>
    </div>
  )
}
