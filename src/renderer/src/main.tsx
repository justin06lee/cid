import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Overlay from './Overlay'
import './styles.css'

// One bundle, two faces. Which one this window is was decided by the URL hash
// when main created it.
const face = location.hash === '#overlay' ? 'overlay' : 'library'
if (face === 'overlay') document.body.classList.add('is-overlay')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{face === 'overlay' ? <Overlay /> : <App />}</StrictMode>
)
