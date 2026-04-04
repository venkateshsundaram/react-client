import './App.css';

export default function App() {

  return (
    <div className="min-h-screen bg-[#242424] text-white flex flex-col items-center justify-center p-8 text-center font-sans tracking-wide">
      <div className="mb-8">
        <a href="https://react.dev" target="_blank" rel="noreferrer">
          <img 
            src="/logo512.png" 
            className="h-32 p-4 transition-all duration-300 hover:drop-shadow-[0_0_2em_#61dafbaa] animate-[spin_20s_linear_infinite]" 
            alt="React logo" 
          />
        </a>
      </div>
      
      <h1 className="text-5xl font-extrabold leading-tight mb-8">
        React + Tailwind + Typescript + React Client
      </h1>
      
      <div className="bg-[#1a1a1a] p-8 rounded-2xl mb-8 border border-[#2e2e2e]">
        <p className="mt-4 text-[#888] font-medium">
          Edit <code className="text-white bg-[#000] px-1 rounded">src/App.tsx</code> and save to test HMR
        </p>
      </div>
      
      <p className="text-[#888] italic">
        Click on the React logo to learn more
      </p>
    </div>
  );
}
