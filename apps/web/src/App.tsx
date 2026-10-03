import { useRoute } from "./lib/router.ts";
import { useTheme } from "./components/TopBar.tsx";
import { Home } from "./pages/Home.tsx";
import { RepoView } from "./pages/RepoView.tsx";
import { LearnIndex, LearnPlaceholder } from "./pages/Learn.tsx";

export function App() {
  const route = useRoute();
  useTheme();
  const [section, id] = route.path;
  if (section === "repo" && id) return <RepoView key={id} route={route} id={id} />;
  if (section === "learn" && id) return <LearnPlaceholder id={id} />;
  if (section === "learn") return <LearnIndex />;
  return <Home />;
}
