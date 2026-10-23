import { createFileRoute } from "@tanstack/react-router";
import { ComputersPageView } from "../components/computers/ComputersPageView";
import { useComputers } from "../hooks/useComputers";
import { useClientSettings } from "../hooks/useSettings";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";

function ComputersPage() {
  const { model, actions } = useComputers();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  useEscapeToGoBack();
  return <ComputersPageView model={model} actions={actions} timestampFormat={timestampFormat} />;
}

export const Route = createFileRoute("/computers")({ component: ComputersPage });
