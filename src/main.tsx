import React from 'react'
import ReactDOM from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './styles/base.css'
import './styles/main-window.css'
import './styles/readers.css'
import './styles/inspector.css'
import './styles/overlays.css'
import './styles/settings.css'
import { AppProvider } from './app/context'
import { MainWindow } from './main-window/MainWindow'
import { SettingsWindow } from './settings/SettingsWindow'
import { WritingWindow } from './windows/WritingWindow'
import { AboutWindow } from './windows/AboutWindow'

const route = window.freddie.route

function Root(): JSX.Element {
  switch (route.kind) {
    case 'settings':
      return <SettingsWindow />
    case 'writing':
      return <WritingWindow />
    case 'about':
      return <AboutWindow />
    default:
      return <MainWindow />
  }
}

document.documentElement.dataset.window = route.kind
document.documentElement.dataset.windowMaterial = window.freddie.windowMaterial
// Like a native control, the selected segment turns gray while the window is inactive.
window.addEventListener('blur', () => document.body.classList.add('window-inactive'))
window.addEventListener('focus', () => document.body.classList.remove('window-inactive'))

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppProvider>
      <Root />
    </AppProvider>
  </React.StrictMode>
)
