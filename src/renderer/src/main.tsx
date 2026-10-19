import '@fontsource-variable/source-serif-4/opsz.css'
import './styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { api } from './api'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App api={api} />
  </React.StrictMode>,
)
