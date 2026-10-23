import type { ReactNode } from 'react'
import { useApp } from '../app/context'

function ExternalLink({ title, url }: { title: string; url: string }): JSX.Element {
  return <button type="button" className="link-button" onClick={() => void window.freddie.shell.openExternal(url)}>{title}</button>
}

function Credit({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div className="about-credit">
      <div className="about-credit-title">{title}</div>
      <div className="about-credit-items">{children}</div>
    </div>
  )
}

export function AboutWindow(): JSX.Element {
  const { t } = useApp()
  return (
    <div className="about-window drag-region">
      <div className="about-identity">
        <img src="./icon.png" alt="" width={85} height={85} />
        <div className="about-name">Freddie</div>
        <div className="about-version secondary selectable no-drag">{t('Version %@', __APP_VERSION__)}</div>
        <div className="about-copyright secondary">Copyright © 2026 SYYANI.</div>
        <div className="no-drag"><ExternalLink title="github.com/SYYANI/Freddie" url="https://github.com/SYYANI/Freddie" /></div>
      </div>
      <div className="about-credits no-drag">
        <h3>{t('Credits')}</h3>
        <Credit title={t('Development')}><ExternalLink title="SYYANI" url="https://github.com/SYYANI" /></Credit>
        <Credit title={t('Document Reading')}><span>PDF.js · Cheerio</span><ExternalLink title="Mozilla Readability" url="https://github.com/mozilla/readability" /></Credit>
        <Credit title={t('Interface and Localization')}><span>Electron · React · CodeMirror</span></Credit>
        <Credit title={t('Open Source License')}><ExternalLink title="GNU AGPL v3.0" url="https://www.gnu.org/licenses/agpl-3.0.html" /></Credit>
      </div>
    </div>
  )
}
