import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import '@fontsource/lora/400.css';
import '@fontsource/lora/500.css';
import './styles.css';
import App from './App';

class ErrorBoundary extends React.Component<{children:React.ReactNode},{error:string|null}> {
  state = {error:null as string|null};
  static getDerivedStateFromError(error:Error) { return {error:error.message}; }
  render() { return this.state.error ? <main className="fatal"><h1>Something needs another look.</h1><p>The page could not finish loading. Your saved records remain on the server.</p><button onClick={()=>window.location.reload()}>Reload workspace</button></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<><ErrorBoundary><App /></ErrorBoundary><footer style={{padding:'12px 16px',textAlign:'center',fontSize:13}}><a href={import.meta.env.VITE_SOURCE_URL||"https://github.com/murdawkmedia/quiet-ledger"} target="_blank" rel="noreferrer">Source code · AGPL-3.0-or-later</a></footer></>);
