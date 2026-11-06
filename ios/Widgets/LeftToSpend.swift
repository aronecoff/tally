import SwiftUI
import WidgetKit

@main
struct Widgets: WidgetBundle {
    var body: some Widget { LeftToSpend() }
}

struct LeftToSpend: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: WidgetSnapshot.kind, provider: Provider()) { entry in
            FaceView(face: entry.face)
        }
        .configurationDisplayName("Left to spend")
        .description("What is left of this month's budget, as of the last time the app was open.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryCircular, .accessoryInline])
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let face: WidgetFace
}

/// The widget reads the file the app wrote and shows it. The app reloads it after each
/// write, and in between the only thing that changes is how old the figures are.
struct Provider: TimelineProvider {
    private func read() -> WidgetSnapshot? { WidgetSnapshot.file.flatMap(WidgetSnapshot.read) }

    func placeholder(in context: Context) -> Entry { Entry(date: .now, face: .sample) }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        let face = WidgetFace.at(.now, snapshot: read(), app: AppName.display)
        // The gallery, for someone with nothing to show yet.
        if context.isPreview, case .prompt = face {
            completion(Entry(date: .now, face: .sample))
        } else {
            completion(Entry(date: .now, face: face))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let now = Date()
        let snapshot = read()
        let moments = [now] + WidgetFace.changes(after: now, snapshot: snapshot)
        let entries = moments.map { Entry(date: $0, face: .at($0, snapshot: snapshot, app: AppName.display)) }
        completion(Timeline(entries: entries, policy: .never))
    }
}

extension WidgetFace {
    /// Invented, for the widget gallery and WidgetKit's placeholder.
    static let sample: WidgetFace = .figure(WidgetFigure(
        snapshot: WidgetSnapshot(
            v: WidgetSnapshot.version, asOf: 1, month: "2026-11", hasBudget: true, budget: 2000, spent: 1587.65, left: 412.35, over: false,
            state: .ok, label: "November · day 22 of 30", stateWord: "On track", whole: "$412", cents: ".35", unit: "left",
            budgetLine: "of $2,000 budget", forecast: "~$1,950 by month-end", rail: 0.79, pace: 0.73
        ),
        headline: "On track",
        updated: "Updated 3:12 PM",
        when: "3:12 PM",
        stale: false
    ))
}

struct FaceView: View {
    let face: WidgetFace
    @Environment(\.widgetFamily) private var family

    var body: some View {
        content
            .accessibilityElement(children: .combine)
            .containerBackground(for: .widget) { Palette.canvas }
    }

    @ViewBuilder private var content: some View {
        switch (face, family) {
        case (.prompt(let line), .accessoryInline):
            Text(line)
        case (.prompt(let line), .accessoryCircular):
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "arrow.clockwise").font(.system(size: 20, weight: .medium))
            }
            .accessibilityLabel(line)
        case (.prompt(let line), .accessoryRectangular):
            Text(line).font(Typeface.demi(14)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
        case (.prompt(let line), _):
            PromptView(line: line)
        case (.figure(let figure), .systemSmall):
            SmallView(figure: figure)
        case (.figure(let figure), .accessoryRectangular):
            RectangularView(figure: figure)
        case (.figure(let figure), .accessoryCircular):
            CircularView(figure: figure)
        case (.figure(let figure), .accessoryInline):
            Text("\(figure.snapshot.whole)\(figure.snapshot.cents) \(figure.snapshot.unit) · \(figure.when)").privacySensitive()
        case (.figure(let figure), _):
            MediumView(figure: figure)
        }
    }
}

/// A line for someone to act on, where a figure would go.
private struct PromptView: View {
    let line: String

    var body: some View {
        Text(line)
            .font(Typeface.display(24))
            .foregroundStyle(Palette.text1)
            .lineLimit(3)
            .minimumScaleFactor(0.8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
    }
}

/// `$412.35 left`, with quieter cents, as Home's hero sets it.
private struct FigureLine: View {
    let figure: WidgetFigure
    let size: CGFloat
    let unitSize: CGFloat

    var body: some View {
        let s = figure.snapshot
        let color = figure.stale ? Palette.text2 : Palette.text1
        let whole = Text(s.whole).font(Typeface.display(size)).foregroundStyle(color)
        let cents = Text(s.cents).font(Typeface.display(size * 0.56)).foregroundStyle(color.opacity(0.6))
        let unit = Text(" \(s.unit)").font(Typeface.ui(unitSize)).foregroundStyle(Palette.text2)
        return Text("\(whole)\(cents)\(unit)")
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .widgetAccentable()
            .privacySensitive()
    }
}

/// The hero's rail: a track, the share of the budget spent, and the pace tick.
private struct Rail: View {
    let figure: WidgetFigure
    var height: CGFloat = 4

    private var fill: Color {
        if figure.stale { return Palette.track }
        switch figure.snapshot.state {
        case .ok: return Palette.fill
        case .pace: return Palette.nearMark
        case .over: return Palette.overMark
        }
    }

    var body: some View {
        GeometryReader { box in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.track).frame(height: height)
                Capsule().fill(fill).frame(width: box.size.width * figure.snapshot.rail, height: height).widgetAccentable()
                Rectangle()
                    .fill(Palette.text1.opacity(0.6))
                    .frame(width: 1.5, height: height + 6)
                    .offset(x: box.size.width * figure.snapshot.pace - 0.75)
            }
            .frame(height: height + 6)
        }
        .frame(height: height + 6)
        .privacySensitive()
    }
}

private func tone(_ figure: WidgetFigure) -> Color {
    if figure.stale { return Palette.text3 }
    switch figure.snapshot.state {
    case .ok: return Palette.ok
    case .pace: return Palette.near
    case .over: return Palette.over
    }
}

private struct SmallView: View {
    let figure: WidgetFigure

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(figure.headline)
                .font(Typeface.demi(14))
                .foregroundStyle(tone(figure))
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .privacySensitive()
            Spacer(minLength: 0)
            FigureLine(figure: figure, size: 40, unitSize: 14)
            Rail(figure: figure).padding(.top, 6)
            Text(figure.updated)
                .font(Typeface.ui(12))
                .foregroundStyle(Palette.text3)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.top, 5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MediumView: View {
    let figure: WidgetFigure

    private var caption: String {
        let s = figure.snapshot
        return s.forecast.isEmpty ? s.budgetLine : "\(s.budgetLine) · \(s.forecast)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text(figure.snapshot.label)
                    .font(Typeface.demi(11))
                    .tracking(1.1)
                    .textCase(.uppercase)
                    .foregroundStyle(Palette.text3)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(figure.updated)
                    .font(Typeface.ui(12))
                    .foregroundStyle(Palette.text3)
                    .lineLimit(1)
                    .layoutPriority(1)
            }
            Spacer(minLength: 0)
            Text(figure.headline)
                .font(Typeface.demi(15))
                .foregroundStyle(tone(figure))
                .lineLimit(1)
                .privacySensitive()
            FigureLine(figure: figure, size: 46, unitSize: 17).padding(.top, 2)
            Rail(figure: figure).padding(.top, 6)
            Text(caption)
                .font(Typeface.ui(13))
                .foregroundStyle(Palette.text2)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.top, 5)
                .privacySensitive()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RectangularView: View {
    let figure: WidgetFigure

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(figure.headline)
                .font(Typeface.demi(13))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .privacySensitive()
            FigureLine(figure: figure, size: 26, unitSize: 13)
            Text(figure.updated)
                .font(Typeface.ui(12))
                .lineLimit(1)
                .opacity(0.75)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct CircularView: View {
    let figure: WidgetFigure

    var body: some View {
        let s = figure.snapshot
        let whole = Text(s.whole).font(Typeface.display(19))
        let cents = Text(s.cents).font(Typeface.display(11))
        return Gauge(value: s.rail) {
            EmptyView()
        } currentValueLabel: {
            Text("\(whole)\(cents)")
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .opacity(figure.stale ? 0.6 : 1)
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .privacySensitive()
    }
}
