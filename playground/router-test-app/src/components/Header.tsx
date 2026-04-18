import React from 'react';

export interface HeaderProps {
  children?: React.ReactNode;
}

export default function Header({ children }: HeaderProps) {
  return (
    <div className="header">
      {children || 'Header component'}
    </div>
  );
}
