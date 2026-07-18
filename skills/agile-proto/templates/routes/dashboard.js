import { html } from "htm/preact";
import { Avatar, AvatarFallback } from "htm-ui/avatar.js";
import { Button } from "htm-ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "htm-ui/card.js";
import { Icon } from "htm-ui/icon.js";

function StatCard({ title, value, change, icon }) {
  return html`
    <${Card}>
      <${CardHeader} className="flex flex-row items-center justify-between space-y-0">
        <${CardTitle} className="text-sm font-medium">${title}<//>
        <${Icon} icon=${icon} className="text-muted-foreground" />
      <//>
      <${CardContent}>
        <div class="text-2xl font-bold">${value}</div>
        <p class="text-xs text-muted-foreground">${change}</p>
      <//>
    <//>
  `;
}

function RecentSale({ name, email, amount }) {
  const initials = name.split(" ").map((n) => n[0]).join("");
  return html`
    <div class="flex items-center gap-4">
      <${Avatar}>
        <${AvatarFallback}>${initials}<//>
      <//>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium leading-none">${name}</p>
        <p class="text-sm text-muted-foreground">${email}</p>
      </div>
      <div class="font-medium">+$${amount}</div>
    </div>
  `;
}

export function DashboardPage() {
  return html`
    <div class="flex flex-col flex-1 w-full h-full overflow-y-auto p-6 space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-muted-foreground text-sm">Welcome back, here's your overview.</p>
        </div>
        <div class="flex items-center gap-2">
          <${Button} variant="outline" size="sm">
            <${Icon} icon="lucide:calendar" size=${14} />
            Jan 20 – Feb 09
          <//>
          <${Button} size="sm">
            <${Icon} icon="lucide:download" size=${14} />
            Download
          <//>
        </div>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <${StatCard} title="Total Revenue" value="$45,231.89" change="+20.1% from last month" icon="lucide:dollar-sign" />
        <${StatCard} title="Subscriptions" value="+2,350" change="+180.1% from last month" icon="lucide:users" />
        <${StatCard} title="Sales" value="+12,234" change="+19% from last month" icon="lucide:credit-card" />
        <${StatCard} title="Active Now" value="+573" change="+201 since last hour" icon="lucide:activity" />
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-7 gap-4">
        <${Card} className="lg:col-span-4">
          <${CardHeader}>
            <${CardTitle}>Overview<//>
          <//>
          <${CardContent}>
            <div class="flex items-end gap-2 h-[200px]">
              ${[40, 25, 55, 45, 65, 35, 75, 50, 60, 30, 70, 45].map(
                (h, i) => html`
                  <div key=${i} class="flex-1 rounded-t bg-primary/80" style="height: ${h}%"></div>
                `,
              )}
            </div>
            <div class="flex justify-between text-xs text-muted-foreground mt-2">
              <span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span>
              <span>May</span><span>Jun</span><span>Jul</span><span>Aug</span>
              <span>Sep</span><span>Oct</span><span>Nov</span><span>Dec</span>
            </div>
          <//>
        <//>

        <${Card} className="lg:col-span-3">
          <${CardHeader}>
            <${CardTitle}>Recent Sales<//>
            <${CardDescription}>You made 265 sales this month.<//>
          <//>
          <${CardContent} className="space-y-6">
            <${RecentSale} name="Olivia Martin" email="olivia@email.com" amount="1,999.00" />
            <${RecentSale} name="Jackson Lee" email="jackson@email.com" amount="39.00" />
            <${RecentSale} name="Isabella Nguyen" email="isabella@email.com" amount="299.00" />
            <${RecentSale} name="William Kim" email="will@email.com" amount="99.00" />
            <${RecentSale} name="Sofia Davis" email="sofia@email.com" amount="39.00" />
          <//>
        <//>
      </div>
    </div>
  `;
}
