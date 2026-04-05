import { filterState } from "../store/state";

export const TodoFilters = () => {
  const filter = filterState.useState();

  const filters = [
    { id: "all", label: "All", icon: "📋" },
    { id: "pending", label: "Pending", icon: "⏳" },
    { id: "completed", label: "Completed", icon: "✅" },
  ];

  return (
    <div className="flex gap-4">
      {filters.map((f) => (
        <button
          key={f.id}
          onClick={() => filterState.set(f.id)}
          className={`px-5 py-2.5 rounded-[1rem] font-bold text-sm flex items-center gap-2 transition-all ${
            filter === f.id
              ? "bg-[#4f46e5] text-white shadow-lg shadow-indigo-200/50 scale-105"
              : "bg-[#f1f5f9] text-[#64748b] hover:bg-[#e2e8f0]"
          }`}
        >
          <span className="text-base">{f.icon}</span>
          <span>{f.label}</span>
        </button>
      ))}
    </div>
  );
};
