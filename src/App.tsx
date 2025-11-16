// src/App.tsx
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
} from "react-router-dom";
import Login from "./pages/Login";
import Compare from "./pages/Compare";

// Strážca routy – ak nie si prihlásený, presmeruje na /login a uloží "from" pre návrat
function RequireAuth() {
  const location = useLocation();
  const ok = typeof window !== "undefined" && localStorage.getItem("etis_auth") === "1";

  return ok ? (
    <Outlet />
  ) : (
    <Navigate to="/login" replace state={{ from: location }} />
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* root → login */}
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* login je verejný */}
        <Route path="/login" element={<Login />} />

        {/* chránená sekcia */}
        <Route element={<RequireAuth />}>
          <Route path="/compare" element={<Compare />} />
        </Route>

        {/* fallback – hocijaká zlá URL → login */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}




