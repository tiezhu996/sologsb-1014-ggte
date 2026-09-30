import 'bulma/css/bulma.css';
import 'katex/dist/katex.min.css';
import './styles.css';
import m from 'mithril';
import { ProofApp } from './app';

m.mount(document.getElementById('app') as HTMLElement, new ProofApp());
