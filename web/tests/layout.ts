import { expect, type Page } from "@playwright/test";

// Check rendered hit areas, including across separate component roots.
export async function expectActionSpacing(page: Page) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const issues: string[] = [];
        if (document.documentElement.scrollWidth > innerWidth + 1)
          issues.push("Page overflows the viewport");
        const controls = Array.from(
          document.querySelectorAll(
            "main button, main a.button, main .action-group > a, main .links > a",
          ),
        )
          .filter((node) => node.checkVisibility())
          .map((node) => ({
            label: node.textContent?.trim(),
            box: node.getBoundingClientRect(),
          }));
        for (let i = 0; i < controls.length; i++) {
          const a = controls[i]!;
          if (a.box.left < -1 || a.box.right > innerWidth + 1)
            issues.push(`${a.label} exceeds the viewport`);
          for (const b of controls.slice(i + 1)) {
            const dx = Math.max(
              a.box.left - b.box.right,
              b.box.left - a.box.right,
            );
            const dy = Math.max(
              a.box.top - b.box.bottom,
              b.box.top - a.box.bottom,
            );
            if (dx < 11.5 && dy < 11.5)
              issues.push(`${a.label} / ${b.label}: ${dx}, ${dy}`);
          }
        }
        return issues;
      }),
    )
    .toEqual([]);
}

export const layoutWidths = [1440, 1024, 768, 390, 320];
