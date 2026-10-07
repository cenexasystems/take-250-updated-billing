import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertCircle, RefreshCw, Home } from 'lucide-react'
import { BRAND_EN } from '../../lib/brand'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary] Uncaught exception captured:', error, errorInfo)

    // Automatically reload once if dynamic chunk failed due to a new deployment
    const msg = error?.message || ''
    if (
      msg.includes('Failed to fetch dynamically imported module') ||
      msg.includes('Expected a JavaScript-or-Wasm module script') ||
      msg.includes('Importing a module script failed') ||
      msg.includes('error loading dynamically imported module')
    ) {
      const lastReload = sessionStorage.getItem('chunk_reload_ts')
      const now = Date.now()
      if (!lastReload || now - Number(lastReload) > 10000) {
        sessionStorage.setItem('chunk_reload_ts', String(now))
        window.location.reload()
      }
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleGoHome = () => {
    window.location.href = '/'
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="min-h-screen bg-[#FBFAF6] flex items-center justify-center p-4">
          <div className="bg-white max-w-lg w-full rounded-3xl border border-gray-200 shadow-2xl p-6 sm:p-8 text-center space-y-5 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-[#D4AF37] flex items-center justify-center text-[#D4AF37] mx-auto shadow-sm">
              <AlertCircle size={28} />
            </div>

            <div>
              <h2 className="text-xl font-black text-[#7A1220] tracking-wide">
                Something went wrong
              </h2>
              <p className="text-xs text-gray-500 mt-1.5 font-medium">
                {BRAND_EN} encountered an unexpected display exception. Your data and orders remain safe.
              </p>
            </div>

            {this.state.error && (
              <div className="bg-[#FBFAF6] border border-gray-200 rounded-2xl p-3.5 text-left text-xs font-mono text-gray-700 max-h-32 overflow-y-auto break-words select-all">
                {this.state.error.message || 'Unknown application error'}
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-gray-300 text-xs font-bold text-gray-700 hover:bg-gray-100 transition-colors cursor-pointer"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl bg-[#7A1220] border border-[#D4AF37] text-[#D4AF37] text-xs font-black uppercase tracking-wider hover:bg-[#1A1A1A] transition-all shadow-md cursor-pointer"
              >
                <RefreshCw size={14} />
                <span>Reload Page</span>
              </button>
              <button
                type="button"
                onClick={this.handleGoHome}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-800 text-xs font-bold transition-colors cursor-pointer"
              >
                <Home size={14} />
                <span>Home</span>
              </button>
            </div>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
