
import React from 'react';
import { renderToString } from 'react-dom/server';
import Home from './pages/index';
export async function render(url:string){ const Page = Home; return renderToString(React.createElement(Page)); }
