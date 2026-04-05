import { todoState } from "../store/state";

export const TodoStats = () => {
  const todos = todoState.useState();
  const total = (todos || []).length;
  const completed = (todos || []).filter((todo) => todo.completed).length;
  const pending = total - completed;

  return (
    <div className="flex gap-6 font-bold">
      <div className="flex flex-col items-center">
        <span className="text-slate-400 text-[10px] mb-1 uppercase tracking-wider font-semibold">Pending</span>
        <span className="text-amber-600 bg-amber-50 px-3 py-1 rounded-lg text-sm min-w-[36px] text-center border border-amber-100/50">{pending}</span>
      </div>
      <div className="flex flex-col items-center">
        <span className="text-slate-400 text-[10px] mb-1 uppercase tracking-wider font-semibold">Completed</span>
        <span className="text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg text-sm min-w-[36px] text-center border border-emerald-100/50">{completed}</span>
      </div>
    </div>
  );
};
