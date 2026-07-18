import { html } from "htm/preact";
import { Button } from "htm-ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "htm-ui/card.js";
import { Input } from "htm-ui/input.js";
import { Label } from "htm-ui/label.js";
import { Separator } from "htm-ui/separator.js";
import { Textarea } from "htm-ui/textarea.js";

export function SettingsPage() {
  return html`
    <div class="flex flex-col flex-1 w-full h-full overflow-y-auto p-6 space-y-6 max-w-3xl">
      <${Card}>
        <${CardHeader}>
          <${CardTitle}>Profile<//>
          <${CardDescription}>Public profile shown across the workspace.<//>
        <//>
        <${CardContent} className="space-y-4">
          <div class="space-y-2">
            <${Label} for="name">Display name<//>
            <${Input} id="name" value="Ada Lovelace" />
          </div>
          <div class="space-y-2">
            <${Label} for="email">Email<//>
            <${Input} id="email" type="email" value="ada@example.com" />
          </div>
          <div class="space-y-2">
            <${Label} for="bio">Bio<//>
            <${Textarea} id="bio">Building delightful products with code.</${Textarea}>
          </div>
        <//>
      <//>

      <${Card}>
        <${CardHeader}>
          <${CardTitle}>Danger zone<//>
          <${CardDescription}>Irreversible actions affecting this workspace.<//>
        <//>
        <${CardContent} className="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium">Delete workspace</p>
              <p class="text-sm text-muted-foreground">All data will be permanently removed.</p>
            </div>
            <${Button} variant="destructive" size="sm">Delete<//>
          </div>
          <${Separator} />
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium">Reset settings</p>
              <p class="text-sm text-muted-foreground">Restore default preferences.</p>
            </div>
            <${Button} variant="outline" size="sm">Reset<//>
          </div>
        <//>
      <//>
    </div>
  `;
}
