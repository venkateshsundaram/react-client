import React from 'react';
import { renderToString } from 'react-dom/server';
import Home from './pages/index';
export async function render(url) { const Page = Home; return renderToString(React.createElement(Page)); }
