import { useState } from "react";
import { todoState } from "../store/state";

export const TodoItem = ({ todo }) => {
  const todos = todoState.useState();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(todo.text);

  const toggleTodo = () => {
    todoState.set(
      todos.map((t) =>
        t.id === todo.id ? { ...t, completed: !t.completed } : t
      )
    );
  };

  const deleteTodo = () => {
    todoState.set(todos.filter((t) => t.id !== todo.id));
  };

  const saveEdit = (e) => {
    e.preventDefault();
    if (!editText.trim()) return;

    todoState.set(
      todos.map((t) =>
        t.id === todo.id ? { ...t, text: editText.trim() } : t
      )
    );
    setIsEditing(false);
  };

  return (
    <div
      className={`group flex items-center justify-between p-5 rounded-[1.2rem] transition-all duration-500 border border-slate-100 ${
        todo.completed
          ? "bg-slate-50/50 opacity-60"
          : "bg-white shadow-sm hover:shadow-md hover:-translate-y-0.5"
      }`}
    >
      <div className="flex items-center gap-5 flex-1">
        {/* custom toggle circle */}
        <button
          onClick={toggleTodo}
          className={`w-7 h-7 rounded-full border-2 transition-all flex items-center justify-center shrink-0 ${
            todo.completed
              ? "bg-[#10b981] border-[#10b981] text-white shadow-md shadow-emerald-100"
              : "border-slate-200 hover:border-[#4f46e5]/50 bg-white group-hover:scale-110"
          }`}
        >
          {todo.completed && <span className="text-xs">✓</span>}
        </button>

        {isEditing ? (
          <form onSubmit={saveEdit} className="flex-1">
            <input
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full bg-slate-50 border border-indigo-100 rounded-lg py-1.5 px-3 text-base focus:outline-none focus:border-indigo-400 text-slate-700 font-medium"
              autoFocus
              onBlur={() => setIsEditing(false)}
            />
          </form>
        ) : (
          <span
            onClick={toggleTodo}
            className={`text-lg font-bold cursor-pointer transition-all tracking-tight ${
              todo.completed ? "text-slate-400 line-through" : "text-slate-700"
            }`}
          >
            {todo.text}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100 transition-all duration-300 transform translate-x-2 group-hover:translate-x-0">
        {!todo.completed && !isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="p-2 text-slate-300 hover:text-[#4f46e5] hover:bg-indigo-50 rounded-lg transition-all"
            title="Edit task"
          >
            <span className="text-lg">✏️</span>
          </button>
        )}
        <button
          onClick={deleteTodo}
          className="p-2 text-slate-300 hover:text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
          title="Delete task"
        >
          <span className="text-lg">🗑️</span>
        </button>
      </div>
    </div>
  );
};
