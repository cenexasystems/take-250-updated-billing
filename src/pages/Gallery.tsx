import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, X, ZoomIn } from 'lucide-react'
import { galleryImages, type GalleryImage } from '../data/galleryImages'
import { BRAND_EN } from '../lib/brand'
import { useBodyScrollLock } from '../hooks/useBodyScrollLock'

// ── Lightbox ────────────────────────────────────────────────────────────────
function Lightbox({
  images,
  startIndex,
  onClose,
}: {
  images: GalleryImage[]
  startIndex: number
  onClose: () => void
}) {
  const [current, setCurrent] = useState(startIndex)
  const touchStartX = useRef(0)

  const prev = () => setCurrent((i) => (i - 1 + images.length) % images.length)
  const next = () => setCurrent((i) => (i + 1) % images.length)

  useBodyScrollLock(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') prev()
      if (e.key === 'ArrowRight') next()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
  }
  const handleTouchEnd = (e: React.TouchEvent) => {
    const diff = touchStartX.current - e.changedTouches[0].clientX
    if (Math.abs(diff) > 48) {
      if (diff > 0) next()
      else prev()
    }
  }

  const img = images[current]

  return createPortal(
    <motion.div
      className="fixed inset-0 z-[100] bg-black/96 flex flex-col items-center justify-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-20 flex h-10 w-10 items-center justify-center
          rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        aria-label="Close"
      >
        <X size={18} />
      </button>

      {/* Counter */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20
        text-[12px] font-bold text-white/60 tracking-widest select-none">
        {current + 1} / {images.length}
      </div>

      {/* Prev button */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); prev() }}
        className="absolute left-3 sm:left-6 z-20 flex h-11 w-11 items-center justify-center
          rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        aria-label="Previous"
      >
        <ArrowLeft size={20} />
      </button>

      {/* Image */}
      <AnimatePresence mode="wait">
        <motion.div
          key={current}
          className="relative flex items-center justify-center px-16 sm:px-20"
          style={{ maxHeight: '88dvh', maxWidth: '92vw' }}
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={img.image}
            alt={img.title}
            className="rounded-2xl object-contain shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
            style={{ maxHeight: '82dvh', maxWidth: '82vw', width: 'auto', height: 'auto' }}
            draggable={false}
          />
        </motion.div>
      </AnimatePresence>

      {/* Next button */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); next() }}
        className="absolute right-3 sm:right-6 z-20 flex h-11 w-11 items-center justify-center
          rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        aria-label="Next"
      >
        <ArrowRight size={20} />
      </button>

      {/* Caption */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 text-center px-4 select-none">
        <p className="text-[14px] font-bold text-white/90">{img.title}</p>
        <p className="text-[12px] text-white/50 mt-1">{img.description}</p>
      </div>

      {/* Dot navigation */}
      <div className="absolute bottom-16 left-1/2 -translate-x-1/2 flex gap-1.5 z-20">
        {images.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={(e) => { e.stopPropagation(); setCurrent(i) }}
            className={`h-1.5 rounded-full transition-all duration-200 ${
              i === current ? 'w-5 bg-white' : 'w-1.5 bg-white/35 hover:bg-white/55'
            }`}
            aria-label={`Go to image ${i + 1}`}
          />
        ))}
      </div>
    </motion.div>,
    document.body
  )
}

// ── Gallery Page ─────────────────────────────────────────────────────────────
export default function Gallery() {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null)

  return (
    <div className="bg-[#F9FAFB] min-h-screen">

      {/* Header */}
      <div
        className="relative py-16 sm:py-24 text-center overflow-hidden"
        style={{ background: 'linear-gradient(160deg, #f0f5ec 0%, #faf8f4 100%)' }}
      >
        <div
          className="absolute inset-0 opacity-[0.04] pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(circle, #111111 1.5px, transparent 1.5px)',
            backgroundSize: '28px 28px',
          }}
        />
        <motion.div
          className="relative z-10 max-w-2xl mx-auto px-4"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.65, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-[10px] font-black uppercase tracking-[0.26em] text-[#D4AF37] mb-4">
            {BRAND_EN}
          </p>
          <h1 className="text-[2.8rem] sm:text-[3.6rem] font-black text-[#111111] tracking-tight leading-[1.02] mb-4">
            Inside Our Store
          </h1>
          <p className="text-[14px] sm:text-[16px] font-bold text-[#8A6A0A] mb-4">
            Sevoor, Arani
          </p>
          <p className="text-[15px] text-[#374151] font-medium leading-[1.7] max-w-lg mx-auto">
            Explore our traditional herbal and pooja store through real photographs
            from our shop. Every shelf tells a story of heritage and trust.
          </p>
        </motion.div>
      </div>

      {/* Masonry Gallery */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12 sm:py-16">

        {/* Stats bar */}
        <div className="flex flex-wrap justify-center gap-8 sm:gap-14 mb-12 sm:mb-16">
          {[
            { value: '80+', label: 'Years of Heritage' },
            { value: '500+', label: 'Products Available' },
            { value: '1000+', label: 'Happy Customers' },
            { value: '100%', label: 'Authentic & Natural' },
          ].map((stat) => (
            <div key={stat.label} className="text-center">
              <p className="text-[2rem] sm:text-[2.5rem] font-black text-[#111111] leading-none">{stat.value}</p>
              <p className="text-[11px] font-bold text-[#374151] mt-1 uppercase tracking-[0.15em]">{stat.label}</p>
            </div>
          ))}
        </div>

        {/* CSS Columns masonry */}
        <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 sm:gap-5">
          {galleryImages.map((img, idx) => (
            <motion.div
              key={img.id}
              className="break-inside-avoid mb-4 sm:mb-5 group cursor-pointer"
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.55, delay: (idx % 3) * 0.06, ease: [0.22, 1, 0.36, 1] }}
              onClick={() => setLightboxIndex(idx)}
            >
              <div className="relative overflow-hidden rounded-[20px] sm:rounded-[24px]
                shadow-[0_6px_24px_rgba(44,57,42,0.10)]
                hover:shadow-[0_16px_44px_rgba(44,57,42,0.18)]
                transition-shadow duration-300 bg-[#E5E7EB]/20">
                <img
                  src={img.image}
                  alt={img.title}
                  loading="lazy"
                  className="w-full h-auto object-cover block
                    group-hover:scale-[1.04] transition-transform duration-500 ease-out"
                />
                {/* Hover overlay */}
                <div className="absolute inset-0 bg-[#111111]/0 group-hover:bg-[#111111]/40
                  transition-colors duration-300 flex items-center justify-center">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300
                    flex flex-col items-center gap-2 text-white">
                    <ZoomIn size={28} strokeWidth={1.5} />
                    <span className="text-[12px] font-bold tracking-wide">{img.title}</span>
                  </div>
                </div>
                {/* Heritage badge on first image */}
                {idx === 0 && (
                  <div className="absolute top-3 left-3 bg-[#111111] text-white
                    text-[9px] font-black uppercase tracking-[0.2em]
                    px-2.5 py-1 rounded-full">
                    Since 1945
                  </div>
                )}
              </div>
            </motion.div>
          ))}
        </div>

      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxIndex !== null && (
          <Lightbox
            images={galleryImages}
            startIndex={lightboxIndex}
            onClose={() => setLightboxIndex(null)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
