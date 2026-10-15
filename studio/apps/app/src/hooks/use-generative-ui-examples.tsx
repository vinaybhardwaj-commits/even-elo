import { z } from "zod";
import { useTheme } from "@/hooks/use-theme";

// CopiotKit imports
import {
  useComponent,
  useFrontendTool,
  useDefaultRenderTool,
  useRenderTool,
} from "@copilotkit/react-core/v2";

// Generative UI imports
import { PieChart, PieChartProps } from "@/components/generative-ui/charts/pie-chart";
import { BarChart, BarChartProps } from "@/components/generative-ui/charts/bar-chart";
import { ToolReasoning } from "@/components/tool-rendering";
import { PlanCard } from "@/components/generative-ui/plan-card";
import { GOVERNANCE_TOOL_NAMES, SourceTable } from "@/components/generative-ui/source-table";

export const useGenerativeUIExamples = () => {
  const { theme, setTheme } = useTheme();

  // ------------------
  // 🪁 Frontend Tools: https://docs.copilotkit.ai/langgraph/frontend-actions
  // ------------------
  useFrontendTool({
    name: "toggleTheme",
    description: "Frontend tool for toggling the theme of the app.",
    parameters: z.object({}),
    handler: async () => {
      setTheme(theme === "dark" ? "light" : "dark")
    },
  }, [theme, setTheme]);

  // --------------------------
  // 🪁 Frontend Generative UI: https://docs.copilotkit.ai/langgraph/generative-ui/frontend-tools
  // --------------------------
  useComponent({
    name: "pieChart",
    description: "Controlled Generative UI that displays data as a pie chart.",
    parameters: PieChartProps,
    render: PieChart,
  });

  useComponent({
    name: "barChart",
    description: "Controlled Generative UI that displays data as a bar chart.",
    parameters: BarChartProps,
    render: BarChart,
  });

  // --------------------------
  // 🪁 Plan Visualization: Custom rendering for the planning step
  // --------------------------
  const PlanVisualizationParams = z.object({
    approach: z.string(),
    technology: z.string(),
    key_elements: z.array(z.string()),
  });
  useRenderTool({
    name: "plan_visualization",
    parameters: PlanVisualizationParams,
    render: ({ status, parameters }) => {
      const { key_elements: keyElements, ...rest } = parameters;
      return <PlanCard status={status} keyElements={keyElements} {...rest} />;
    },
  });

  // --------------------------
  // Governance read tools render ONLY through the typed SourceTable (requires `source`).
  // The list is fixed, so these hook calls run in the same order on every render.
  // --------------------------
  for (const name of GOVERNANCE_TOOL_NAMES) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useRenderTool({
      name,
      parameters: z.object({}).passthrough(),
      render: ({ status, result }) =>
        status === "complete" ? <SourceTable result={result} /> : <ToolReasoning name={name} status={status} />,
    });
  }

  // --------------------------
  // 🪁 Default Tool Rendering: https://docs.copilotkit.ai/langgraph/generative-ui/backend-tools
  // --------------------------
  useDefaultRenderTool({
    render: ({ name, status, parameters }) => {
      return <ToolReasoning name={name} status={status} args={parameters} />;
    },
  });

  // Human-in-the-loop pattern (kept as documentation; the demo picker was removed):
  //   useHumanInTheLoop({
  //     name, description, parameters: z.object({...}),
  //     render: ({ respond, status, args }) => <Picker status={status} respond={respond} {...args} />,
  //   });
  // The component calls respond(result) once the user decides; the agent run resumes with it.
};
