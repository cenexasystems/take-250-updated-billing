import React from 'react'

interface CenexaFooterProps {
  className?: string
  sticky?: boolean
}

/**
 * Universal footer for every page.
 * Displays "Powered by Cenexa Systems © 2026" pinned at the bottom of the screen,
 * staying stationary while the page content scrolls behind it.
 */
export default function CenexaFooter({ className = '', sticky = false }: CenexaFooterProps) {
  return (
    <footer
      className={`${
        sticky ? 'sticky bottom-0 z-30' : 'shrink-0'
      } w-full border-t border-gray-200/50 bg-white/95 backdrop-blur-xs py-2 px-3 text-center text-[11px] sm:text-[12px] font-semibold text-gray-500 tracking-wide select-none print:hidden ${className}`}
      style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      aria-label="Footer"
    >
      Powered by Cenexa Systems &copy; 2026
    </footer>
  )
}
