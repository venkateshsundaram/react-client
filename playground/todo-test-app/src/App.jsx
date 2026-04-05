import { useState } from "react";
import { TodoList } from "./components/TodoList";
import { TodoFilters } from "./components/TodoFilters";
import { TodoStats } from "./components/TodoStats";
import { todoState } from "./store/state";

function App() {
  const todos = todoState.useState();
  const [inputValue, setInputValue] = useState("");

  const addTodo = (e) => {
    e.preventDefault();
    if (!inputValue.trim()) return;

    const newTodo = {
      id: Date.now().toString(),
      text: inputValue.trim(),
      completed: false,
    };

    todoState.set([...todos, newTodo]);
    setInputValue("");
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] py-12 px-4">
      <div className="max-w-[600px] mx-auto">
        <div className="bg-white rounded-[2rem] design-shadow overflow-hidden min-h-[600px] flex flex-col">
          {/* Header section with purple gradient */}
          <div className="bg-gradient-to-r from-[#5b21b6] to-[#7c3aed] p-10 text-white text-left">
            <h1 className="text-4xl font-black mb-2 leading-tight tracking-tight">My Journey</h1>
            <p className="text-base text-purple-100/90 font-medium opacity-90">Capture your thoughts, one task at a time.</p>
          </div>

          <div className="flex-1 p-8 flex flex-col gap-8">
            {/* Input field with nested Add button */}
            <form onSubmit={addTodo} className="relative group">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="What's on your mind today?"
                className="w-full bg-[#f8fafc] border border-slate-100 rounded-[1.2rem] py-4 px-6 pr-28 text-lg text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-4 focus:ring-[#7c3aed]/10 transition-all duration-500 shadow-inner"
              />
              <button
                type="submit"
                className="absolute right-2 top-2 bottom-2 bg-[#4f46e5] hover:bg-[#4338ca] text-white px-6 rounded-[0.8rem] font-bold text-base transition-all shadow-lg shadow-indigo-100 active:scale-95 flex items-center justify-center gap-2"
              >
                <span>Add</span>
                <span className="text-xl">+</span>
              </button>
            </form>

            {/* Filters and Stats row */}
            <div className="space-y-8">
              <div className="flex items-center justify-between">
                <TodoFilters />
                <TodoStats />
              </div>

              {/* Todo list section */}
              <div className="min-h-[300px]">
                <TodoList />
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="bg-slate-50/50 p-6 text-center border-t border-slate-50">
            <p className="text-slate-400 text-sm font-semibold">
              Powered by <span className="text-[#4f46e5] font-black tracking-tight">StateJet</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
