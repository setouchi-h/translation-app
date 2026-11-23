import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { CaptionOverlay } from './components/CaptionOverlay'

// The floating caption window loads this same page with #overlay.
const isOverlay = window.location.hash === '#overlay'
if (isOverlay) {
  document.documentElement.classList.add('overlay')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isOverlay ? <CaptionOverlay /> : <App />}</StrictMode>
)
