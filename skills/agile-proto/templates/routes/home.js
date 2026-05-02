import { html } from "htm/preact";
import { Badge } from "~/components/ui/badge.js";
import { Button } from "~/components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card.js";
import { Icon } from "~/components/ui/icon.js";

export function HomePage() {
  return html`
    <div class="flex flex-col flex-1 w-full h-full overflow-y-auto p-6 space-y-6">
      <div>
        <h2 class="text-3xl font-bold tracking-tight">Welcome</h2>
        <p class="text-muted-foreground text-sm mt-1">
          Replace this scene with your main flow. Use the picker in the header to navigate between scenes.
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <${Card}>
          <${CardHeader}>
            <div class="flex items-start justify-between gap-2">
              <div>
                <${CardTitle}>Quick start<//>
                <${CardDescription}>Start by editing routes/home.js<//>
              </div>
              <${Badge} variant="outline">v1<//>
            </div>
          <//>
          <${CardContent} className="space-y-2">
            <p class="text-sm text-muted-foreground">
              Each scene lives in <code class="text-foreground">routes/*.js</code>. Register it in <code class="text-foreground">index.js</code> inside <code class="text-foreground">SCENES</code>.
            </p>
            <${Button} size="sm" variant="outline">
              <${Icon} icon="lucide:arrow-right" size=${14} />
              See components
            <//>
          <//>
        <//>

        <${Card}>
          <${CardHeader}>
            <${CardTitle}>Next steps<//>
          <//>
          <${CardContent}>
            <ul class="text-sm space-y-2 list-disc pl-4 text-muted-foreground">
              <li>Add scenes to <code class="text-foreground">SCENES</code></li>
              <li>Customize the sidebar in <code class="text-foreground">components/app-shell.js</code></li>
              <li>Adjust colors in <code class="text-foreground">index.css</code> (shadcn variables)</li>
              <li>For Figma MCP capture, open scenes with <code class="text-foreground">?route=scene-id</code> and capture <code class="text-foreground">#app</code></li>
              <li>For manual Figma paste, set <code class="text-foreground">figma-key</code> in <code class="text-foreground">index.html</code></li>
            </ul>
          <//>
        <//>
      </div>
    </div>
  `;
}
