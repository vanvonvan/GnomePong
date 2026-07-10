// A tiny toolkit-agnostic menu model. The front-ends (extension overlay and
// the GTK preview) render it via render.drawMenu() and feed it navigation.

export class Menu {
    // heading: optional string drawn above the items (null for the main menu,
    //          which shows the big PONG title instead).
    // items:   [{ label, action }]
    // footer:  optional array of strings drawn below the items (e.g. the
    //          controls legend). Purely informational.
    constructor(heading, items, footer = null) {
        this.heading = heading;
        this.items = items;
        this.footer = footer;
        this.selected = 0;
    }

    move(delta) {
        const n = this.items.length;
        if (n > 0)
            this.selected = (this.selected + delta + n) % n;
    }

    select(index) {
        if (index >= 0 && index < this.items.length)
            this.selected = index;
    }

    activate() {
        const item = this.items[this.selected];
        if (item && item.action)
            item.action();
    }
}
