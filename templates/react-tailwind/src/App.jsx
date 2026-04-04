import './App.css';

export default function App() {

  return (
    <div className="min-h-screen bg-[#242424] text-white flex flex-col items-center justify-center p-8 text-center font-sans">
      <div className="mb-8">
        <a href="https://react.dev" target="_blank" rel="noreferrer">
          <img
            src="/logo512.png"
            className="h-32 p-4 transition-filter duration-300 hover:drop-shadow-[0_0_2em_#61dafbaa] animate-[spin_20s_linear_infinite]"
            alt="React logo"
          />
        </a>
      </div>

      <h1 className="text-5xl font-bold leading-tight mb-8">
        React + Tailwind + React Client
      </h1>

      <div className="bg-[#1a1a1a] p-8 rounded-xl mb-8">
        <p className="mt-4 text-[#888]">
          Edit <code className="text-white">src/App.jsx</code> and save to test HMR
        </p>
      </div>

      <p className="text-[#888]">
        Click on the React logo to learn more
      </p>
    </div>
  );
}
