import {
  AlignLeft, AppWindowMac, Book, BookOpen, Bookmark, Check, ChevronDown, ChevronRight, ChevronUp, CircleArrowUp, CircleCheck, CircleEllipsis,
  CirclePlus, CircleStop, CircleX, Copy, Earth, Eraser, File, FileClock, FileDown, FilePlus, FileText, FileUp, Folder, FolderMinus, Highlighter,
  Languages, Link, ListTree, Pin, Minus, MessageCircle, MousePointer2, NotebookPen, PanelLeft, PanelRight, PencilLine, Plus, Redo2, RefreshCw,
  RotateCcw, ScanText, ScrollText, Search, Settings, Share, Sparkles, SquarePen, SquareStack, Star, StarOff, StickyNote,
  Strikethrough, TextQuote, Trash2, TriangleAlert, Underline, Undo2, X, type LucideIcon
} from 'lucide-react'
import type { CSSProperties } from 'react'

// SF Symbol names used by native Freddie, mapped to the closest line icons.
const symbols: Record<string, LucideIcon> = {
  'plus': Plus,
  'list.bullet.indent': ListTree,
  'pin': Pin,
  'pin.fill': Pin,
  'chevron.right': ChevronRight,
  'minus': Minus,
  'trash': Trash2,
  'sidebar.left': PanelLeft,
  'sidebar.trailing': PanelRight,
  'magnifyingglass': Search,
  'plus.circle': CirclePlus,
  'translate': Languages,
  'square.and.arrow.up': Share,
  'square.and.pencil': SquarePen,
  'xmark.circle.fill': CircleX,
  'chevron.down': ChevronDown,
  'chevron.up': ChevronUp,
  'macwindow': AppWindowMac,
  'ellipsis.circle': CircleEllipsis,
  'doc.text': FileText,
  'doc.badge.plus': FilePlus,
  'doc': File,
  'doc.richtext': FileText,
  'doc.viewfinder': ScanText,
  'doc.badge.arrow.up': FileUp,
  'arrow.down.doc.fill': FileDown,
  'doc.badge.ellipsis': FileClock,
  'doc.on.doc': Copy,
  'star': Star,
  'star.fill': Star,
  'star.slash': StarOff,
  'character.book.closed': BookOpen,
  'note.text': StickyNote,
  'note.text.badge.plus': NotebookPen,
  'sparkles': Sparkles,
  'bubble.left': MessageCircle,
  'text.quote': TextQuote,
  'arrow.up.circle.fill': CircleArrowUp,
  'stop.circle.fill': CircleStop,
  'xmark': X,
  'checkmark': Check,
  'checkmark.circle.fill': CircleCheck,
  'gearshape': Settings,
  'book.closed': Book,
  'text.document': ScrollText,
  'doc.plaintext': FileText,
  'network': Earth,
  'sparkles.rectangle.stack': SquareStack,
  'folder': Folder,
  'folder.badge.minus': FolderMinus,
  'eraser': Eraser,
  'highlighter': Highlighter,
  'underline': Underline,
  'strikethrough': Strikethrough,
  'cursorarrow': MousePointer2,
  'pencil.tip': PencilLine,
  'arrow.uturn.backward': Undo2,
  'arrow.uturn.forward': Redo2,
  'link': Link,
  'globe': Earth,
  'arrow.clockwise': RefreshCw,
  'arrow.counterclockwise': RotateCcw,
  'bookmark': Bookmark,
  'text.alignleft': AlignLeft,
  'exclamationmark.triangle': TriangleAlert
}

export interface IconProps {
  name: string
  size?: number
  weight?: number
  className?: string
  style?: CSSProperties
  filled?: boolean
}

export function Icon({ name, size = 16, weight = 1.7, className, style, filled }: IconProps): JSX.Element {
  if (name === 'line.3.horizontal.decrease.circle' || name === 'line.3.horizontal.decrease.circle.fill') {
    const isFilled = name.endsWith('.fill')
    return (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8.25" fill={isFilled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.4} />
        <g stroke={isFilled ? 'var(--filter-icon-cutout, #fff)' : 'currentColor'} strokeWidth={1.4} strokeLinecap="round">
          <line x1="6" y1="7.5" x2="14" y2="7.5" />
          <line x1="7.5" y1="10.25" x2="12.5" y2="10.25" />
          <line x1="9" y1="13" x2="11" y2="13" />
        </g>
      </svg>
    )
  }
  if (name === 'circle.dashed') {
    return (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2.6 2.4" />
      </svg>
    )
  }
  if (name === 'pencil.tip.crop.circle') {
    return (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round">
        <circle cx="10" cy="10" r="8.25" />
        <path d="M10 4.6 L12.9 12.6 Q10 14.2 7.1 12.6 Z" />
        <path d="M9.1 7.2 L10.9 7.2" />
      </svg>
    )
  }
  if (name === 'rectangle.and.pencil.and.ellipsis') {
    return (
      <svg className={className} style={style} width={size} height={size} viewBox="0 0 22 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.5" y="4" width="15" height="12" rx="3" />
        <circle cx="5.5" cy="10" r="0.6" fill="currentColor" />
        <circle cx="8.5" cy="10" r="0.6" fill="currentColor" />
        <path d="M13 13.5 L20 6.5 L18.3 4.8 L11.3 11.8 L11 13.8 Z" fill="var(--icon-fill-background, transparent)" />
      </svg>
    )
  }
  const Component = symbols[name] ?? FileText
  return <Component className={className} style={style} size={size} strokeWidth={weight} fill={filled || name.endsWith('.fill') && (name.startsWith('star') || name.startsWith('pin')) ? 'currentColor' : 'none'} aria-hidden="true" />
}
