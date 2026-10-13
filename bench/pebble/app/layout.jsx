import './globals.css';

export const metadata = { title: 'Pebble — small tasks, calm days' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
