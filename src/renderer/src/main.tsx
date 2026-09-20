import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Overlay from './Overlay'
import './styles.css'

// One bundle, two faces. Which one this window is was decided by the URL hash
// when main created it.
const face = location.hash === '#overlay' ? 'overlay' : 'library'
if (face === 'overlay') document.body.classList.add('is-overlay')

// The masthead reserves room for macOS's inset traffic lights. Windows and
// Linux draw their own frame and have nothing to clear, so they get the space
// back — see --masthead-top. Read off the UA rather than through IPC: this has
// to be right on the very first paint, and an await would flash the wrong one.
const ua = navigator.userAgent
document.body.classList.add(
  ua.includes('Mac') ? 'plat-mac' : ua.includes('Win') ? 'plat-win' : 'plat-linux'
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{face === 'overlay' ? <Overlay /> : <App />}</StrictMode>
)
