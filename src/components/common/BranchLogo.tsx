import { useBranchLogo } from '../../lib/branchTheme'
import type { PosBranch } from '../../store/store'

/** A branch's logo from its Store Settings (built-in logo only when the store has none). */
export default function BranchLogo({ branch, alt, className }: { branch: PosBranch; alt: string; className?: string }) {
  const src = useBranchLogo(branch)
  return <img src={src} alt={alt} className={className} />
}
