"""Sash positions. Tk pane weights do not split evenly."""

MIN_PANE = 180


def clamp_sash(width, pos, min_pane=MIN_PANE):
    width = int(width or 0)
    if width <= 0:
        return 0
    if width < min_pane * 2:
        return max(0, width // 2)
    return max(min_pane, min(width - min_pane, int(pos)))


def even_ratios(parts):
    parts = int(parts)
    if parts < 2:
        return []
    return [float(i) / float(parts) for i in range(1, parts)]


def sashes_from_ratios(width, ratios, min_pane=MIN_PANE):
    width = int(width or 0)
    ratios = [float(r) for r in (ratios or [])]
    n = len(ratios) + 1
    if width <= 0 or n < 2:
        return []
    if width < min_pane * n:
        min_pane = max(1, width // n)
    positions = []
    for i, ratio in enumerate(ratios):
        pos = int(round(width * ratio))
        low = min_pane * (i + 1)
        high = width - min_pane * (n - 1 - i)
        if high < low:
            pos = low
        else:
            pos = max(low, min(high, pos))
        if positions and pos < positions[-1] + min_pane:
            pos = positions[-1] + min_pane
        positions.append(pos)
    return positions


def ratios_from_sashes(width, positions):
    width = float(width or 0)
    if width <= 0:
        return even_ratios(len(positions) + 1)
    return [float(pos) / width for pos in positions]


def restored_ratios(doc, parts, layout_version):
    """Return saved sash ratios only for the current layout schema.

    Older client builds used a different workspace composition, so their
    persisted sash ratio can make the current two-pane view start visibly
    off-centre.  A schema mismatch deliberately falls back to an even split.
    """
    default = even_ratios(parts)
    if not isinstance(doc, dict):
        return default
    try:
        saved_version = int(doc.get("layoutVersion", 0))
    except (TypeError, ValueError):
        return default
    if saved_version != int(layout_version):
        return default

    by_count = doc.get("sashRatiosByCount")
    ratios = by_count.get(str(parts)) if isinstance(by_count, dict) else None
    if ratios is None and parts == 2:
        ratios = doc.get("sashRatios")
    if not isinstance(ratios, list) or len(ratios) != parts - 1:
        return default

    try:
        values = [float(value) for value in ratios]
    except (TypeError, ValueError):
        return default
    if any(value <= 0.0 or value >= 1.0 for value in values):
        return default
    if any(values[index] >= values[index + 1] for index in range(len(values) - 1)):
        return default
    return values
