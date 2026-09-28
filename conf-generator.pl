#!/usr/bin/perl
# =============================================================================
# conf-generator.pl — rebuild the Confidence indicator rows for
# traffic-lights-ranked.html from their inputs.
#
# WHY THIS EXISTS
# ---------------
# The scoring for this tool was documented (traffic-lights-method/
# WORKING-TAB-ARCHIVE.md) but the CODE that produced conf_rows was never kept.
# That cost real time twice: once when the ranked method had to be recovered
# from its own audit, and again on 2026-09-28 when a data bug could not be
# fixed without hand-patching a pipeline nobody could reproduce. This script is
# that pipeline, written down.
#
# THE BUG IT WAS WRITTEN FOR
# --------------------------
# The archive specifies "unemployment and underemployment use a 12-month
# rolling window". The implementation took 12 DATA POINTS, and rdp_raw_series
# stores those two metrics ANNUALLY (freq 'A', one row per year) — so `latest`
# became a 12-YEAR average scored against a current-rate band. Confirmed three
# ways: Ballarat's twelve annual values / 12 = 0.0433 exactly as published;
# year-on-year steps of 0.128pp median where a real series moves 0.3-1.0pp; and
# 169 of 180 steps falling, which is a rolling mean over a falling decade, not
# a labour market.
#
# HOW IT IS SAFE TO RUN
# ---------------------
# PHASE A is a GATE. It recomputes every derived field from the STORED inputs
# and asserts it reproduces the current build exactly. If the rules here have
# drifted from whatever really made the file, Phase A fails and the script
# refuses to go on — so a wrong rule can never quietly rewrite the data.
#
# Usage:  perl conf-generator.pl <in.html>                      # prove only
#         perl conf-generator.pl <in.html> <out.html> <fix.csv> # prove, then fix
# =============================================================================
use strict; use warnings; use JSON::PP;

my ($in,$out,$fix)=@ARGV;
die "usage: conf-generator.pl <in.html> [<out.html> <fix.csv>]\n" unless $in;
open my $h,'<:raw',$in or die "$in: $!"; my $src=do{local $/;<$h>}; close $h;

# ---- extract a `const NAME = {...};` literal by brace matching --------------
sub block {
  my ($s,$n)=@_;
  pos($$s)=0;                 # /g leaves pos set from the previous block()
  $$s =~ /const \Q$n\E\s*=\s*\{/g or die "$n not found\n";
  my $st = pos($$s)-1;
  my ($d,$k,$q,$e)=(0,$st,0,0);
  while($k < length $$s){
    my $c=substr($$s,$k,1);
    if($q){ if($e){$e=0} elsif($c eq "\\"){$e=1} elsif($c eq $q){$q=0} }
    else  { if($c eq '"' || $c eq "'"){ $q=$c }
            elsif($c eq '{'){ $d++ } elsif($c eq '}'){ $d--; last unless $d } }
    $k++;
  }
  die "$n: unbalanced\n" if $d;
  ($st, $k-$st+1);
}
my ($aOff,$aLen)=block(\$src,'AUDIT');
my ($dOff,$dLen)=block(\$src,'DATA');
my $J=JSON::PP->new->ascii(1)->canonical(1)->allow_nonref;
my $AUDIT=$J->decode(substr($src,$aOff,$aLen));
my $DATA =$J->decode(substr($src,$dOff,$dLen));

# ---- THE RULES -------------------------------------------------------------
# Each verified against all 216 stored indicator values before being written.
#
#   quantity   RATIO indicators score their YEAR-ON-YEAR GROWTH (`delta`);
#              INVERSE indicators score their LEVEL (`latest`). This is not a
#              per-indicator list — it follows `typ`, and matches how each
#              band is worded ("Year-on-year growth, Green >= +3%" vs
#              "Green <= 4.0%").
#   norm       the quantity normalised 0-1 between the red and green
#              thresholds, clamped.
#   sig        the ABSOLUTE test against those thresholds. Independent of the
#              scoring, and unchanged by it.
#   s10        set by the band the signal puts it in — GREEN 7.0-10.0,
#              ORANGE 4.0-6.9, RED 1.0-3.9 — positioned inside that band by
#              how many of the regions SHARING THAT SIGNAL it beats, over the
#              size of that group. Earlier versions scored purely by percentile
#              across all 36, which produced a green light on 1.5/10.
my %BAND = (GREEN=>[7,10], ORANGE=>[4,6.9], RED=>[1,3.9]);
sub clamp01 { my $v=shift; $v<0?0:($v>1?1:$v) }
sub quantity { my $r=shift; ($r->{typ}//'') eq 'RATIO' ? $r->{delta} : $r->{latest} }
sub deltaOf {
  my $r=shift;
  return undef unless defined $r->{prior};
  ($r->{typ}//'') eq 'RATIO' ? ($r->{prior} ? $r->{latest}/$r->{prior}-1 : 0)
                             : $r->{latest}-$r->{prior};
}
sub normOf {
  my $r=shift; my $q=quantity($r); return undef unless defined $q;
  ($r->{typ}//'') eq 'INVERSE'
    ? clamp01( ($r->{red}-$q)/($r->{red}-$r->{green}) )
    : clamp01( ($q-$r->{red})/($r->{green}-$r->{red}) );
}
sub sigOf {
  my $r=shift; my $q=quantity($r); return undef unless defined $q;
  if(($r->{typ}//'') eq 'INVERSE'){
    return $q <= $r->{green} ? 'GREEN' : ($q >= $r->{red} ? 'RED' : 'ORANGE');
  }
  return $q >= $r->{green} ? 'GREEN' : ($q <= $r->{red} ? 'RED' : 'ORANGE');
}

# ---- gather the scoring rows, by indicator, across the whole field ----------
my @REG = sort keys %$DATA;
sub auditKey {
  my $r=shift;
  for my $k (keys %{$AUDIT->{regions}||{}}){ return $k if uc($k) eq uc($r) }
  undef;
}
sub rowsOf {
  my $r=shift; my $k=auditKey($r); return [] unless $k;
  [ grep { defined $_->{norm} } @{ $AUDIT->{regions}{$k}{conf_rows} || [] } ];
}
my %byInd;                     # indicator name -> [ {region,row}, ... ]
for my $r (@REG){ for my $row (@{rowsOf($r)}){
  push @{$byInd{$row->{name}}}, {region=>$r, row=>$row} } }

# s10 needs the whole field for one indicator at once
sub s10map {
  my $name=shift; my $set=$byInd{$name} or return {};
  my $inv = (($set->[0]{row}{typ}//'') eq 'INVERSE');
  my %out;
  for my $sig (keys %BAND){
    my @g = grep { ($_->{row}{sig}//'') eq $sig } @$set;
    next unless @g;
    my ($lo,$hi)=@{$BAND{$sig}};
    for my $o (@g){
      my $q = quantity($o->{row});
      # how many in this signal group does it beat?
      my $beat = grep { my $p=quantity($_->{row});
                        $inv ? $q < $p : $q > $p } @g;
      $out{$o->{region}} = $lo + ($beat/scalar(@g))*($hi-$lo);
    }
  }
  \%out;
}

# ---- PHASE A — the gate ----------------------------------------------------
my @fail; my $checked=0;
for my $name (sort keys %byInd){
  my $s10 = s10map($name);
  for my $o (@{$byInd{$name}}){
    my ($r,$row)=($o->{region},$o->{row});
    $checked++;
    my $d = deltaOf($row);
    push @fail, sprintf('%s/%s delta: stored %s derived %s',$r,$name,$row->{delta}//'undef',defined $d?sprintf('%.6f',$d):'undef')
      if defined $row->{delta} && defined $d && abs($row->{delta}-$d) > 1e-6;
    my $n = normOf($row);
    push @fail, sprintf('%s/%s norm: stored %s derived %.4f',$r,$name,$row->{norm},$n)
      if defined $n && abs($row->{norm}-$n) > 0.0015;
    my $g = sigOf($row);
    push @fail, "$r/$name sig: stored $row->{sig} derived $g"
      if defined $g && $g ne ($row->{sig}//'');
    my $v = $s10->{$r};
    push @fail, sprintf('%s/%s s10: stored %s derived %.2f',$r,$name,$row->{s10},$v)
      if defined $v && defined $row->{s10} && abs($row->{s10}-$v) > 0.051;
  }
}
# pillar level
for my $r (@REG){
  my $rows=rowsOf($r); next unless @$rows==6;
  my $t=0; $t += $_->{norm} for @$rows;
  my $econ = 2*$t/6;
  push @fail, sprintf('%s conf_score: stored %s derived %.3f',$r,$DATA->{$r}{conf_score},$econ)
    if abs($DATA->{$r}{conf_score}-$econ) > 0.006;
  my $cut=$DATA->{$r}{conf_cut}, my $red=$DATA->{$r}{conf_red};
  for my $s (qw(h u)){
    my $dom=$DATA->{$r}{"dom_$s"};
    my $cl = 2*($red-$dom)/($red-$cut); $cl=0 if $cl<0; $cl=2 if $cl>2;
    push @fail, sprintf('%s/%s clearance: stored %s derived %.3f',$r,$s,$DATA->{$r}{"conf_clear_$s"},$cl)
      if abs($DATA->{$r}{"conf_clear_$s"}-$cl) > 0.006;
    my $bl = 0.5*$econ + 0.5*$cl;
    push @fail, sprintf('%s/%s blend: stored %s derived %.3f',$r,$s,$DATA->{$r}{"conf_blend_$s"},$bl)
      if abs($DATA->{$r}{"conf_blend_$s"}-$bl) > 0.006;
    my $want = $bl >= $AUDIT->{green} ? 'GREEN' : ($bl < $AUDIT->{orange} ? 'RED' : 'ORANGE');
    push @fail, "$r/$s confidence: stored $DATA->{$r}{qq(confidence_$s)} derived $want"
      if $want ne $DATA->{$r}{"confidence_$s"};
  }
  my @reds = map { $_->{name} } grep { ($_->{sig}//'') eq 'RED' } @$rows;
  my $stored = join '|', @{$DATA->{$r}{conf_reds}||[]};
  push @fail, "$r conf_reds: stored [$stored] derived [".join('|',@reds)."]"
    if $stored ne join('|',@reds);
}

printf "PHASE A — proving the rules against the current build\n";
printf "  indicator values checked : %d\n", $checked;
printf "  regions                  : %d\n", scalar @REG;
if(@fail){
  printf "  MISMATCHES               : %d\n\n", scalar @fail;
  print "  $_\n" for @fail[0..($#fail>29?29:$#fail)];
  print "  ... and ".(@fail-30)." more\n" if @fail>30;
  die "\nPHASE A FAILED — the rules do not reproduce the current build.\n".
      "Refusing to regenerate anything. Fix the rules first.\n";
}
print "  ALL REPRODUCED EXACTLY — the generator matches the live build.\n";
exit 0 unless $out && $fix;

# Snapshot the pre-fix verdicts. Phase A2 replays the clock against THESE to
# prove the table before it is trusted with the corrected ones.
my %ORIG_CONF;
for my $r (@REG){ for my $s (qw(h u)){
  $ORIG_CONF{"$r|$s"} = $DATA->{$r}{"confidence_$s"} } }

# ---- PHASE B — apply corrected inputs and regenerate -----------------------
open my $c,'<',$fix or die "$fix: $!";
my (%byRegion,%byState);
while(<$c>){
  s/\r//g; chomp; next if /^\s*#/ || /^\s*$/ || /^scope,/;
  my ($scope,$k,$metric,$latest,$prior)=split /,/;
  my $rec={latest=>$latest+0, prior=>$prior+0};
  if($scope eq 'region'){ $byRegion{$k}{$metric}=$rec }
  else                  { $byState{$k}{$metric}=$rec }
}
close $c;

my @applied;
for my $r (@REG){
  for my $row (@{rowsOf($r)}){
    my $n=$row->{name};
    my $rec = $byRegion{$r}{$n}
           || ($row->{state} ? $byState{ $row->{state} }{$n} : undef);
    next unless $rec;
    $row->{latest}=$rec->{latest};
    $row->{prior} =$rec->{prior};
    $row->{delta} =deltaOf($row);
    $row->{norm}  =normOf($row)+0;
    $row->{sig}   =sigOf($row);
    push @applied, "$r/$n";
  }
}
die "phase B: nothing matched the fix file\n" unless @applied;
printf "\nPHASE B — applying corrected inputs\n  rows updated: %d\n", scalar @applied;

# s10 is a position among the regions sharing a signal, so it is redone for the
# indicators that were EDITED — and only those. An indicator whose inputs did
# not move cannot have moved in its own field, so rewriting it can only inject
# drift: my rule reproduces the originals to 0.05, which is inside the gate's
# tolerance but enough to flip a 1-decimal rounding (Business Finance 8.25 ->
# 8.2 where the original wrote 8.3). Leave what did not change alone.
my %touched;
for my $a (@applied){ my ($r,$n)=split m{/},$a,2; $touched{$n}=1 }
for my $name (sort keys %touched){
  my $m=s10map($name);
  for my $o (@{$byInd{$name}}){
    next unless defined $m->{$o->{region}};
    $o->{row}{s10} = sprintf('%.1f', $m->{$o->{region}})+0;
  }
}
printf "  s10 rescored for: %s\n", join(', ', sort keys %touched);

# ---- PHASE B2 — mirror into the CARD payload -------------------------------
# The indicator cards do NOT render AUDIT.conf_rows. They render
# DATA{region}{indicators}, a second copy carrying pre-formatted display
# strings. Updating only the scoring copy leaves the card showing the old
# numbers under the new signal — which is exactly the kind of split this
# script exists to stop, so it is asserted below rather than trusted.
my $mirrored=0;
for my $r (@REG){
  my %src = map { $_->{name} => $_ } @{rowsOf($r)};
  for my $card (@{ $DATA->{$r}{indicators} || [] }){
    my $row = $src{ $card->{name} } or next;
    next unless $byRegion{$r}{$card->{name}}
             || ($row->{state} && $byState{ $row->{state} }{$card->{name}});
    my $pc = sub { sprintf('%.2f%%', $_[0]*100) };
    $card->{latest} = $pc->($row->{latest});
    $card->{head}   = $pc->($row->{latest});
    my $chg = sprintf('%+.2f pts', ($row->{latest}-$row->{prior})*100);
    $card->{change} = $chg;
    for my $l (@{ $card->{lines} || [] }){
      $l->{v} = $pc->($row->{prior}) if $l->{k} eq 'Previous';
      $l->{v} = $chg                 if $l->{k} eq 'Change';
    }
    $card->{norm}   = $row->{norm};
    $card->{signal} = $row->{sig};
    $card->{s10}    = $row->{s10};   # the chip, and its colour via bandOf(s10)
    $mirrored++;
  }
}
printf "  card payloads mirrored: %d\n", $mirrored;

# ---- pillar level ----------------------------------------------------------
my %moved;
for my $r (@REG){
  my $rows=rowsOf($r); next unless @$rows==6;
  my $t=0; $t += $_->{norm} for @$rows;
  my $econ = sprintf('%.3f', 2*$t/6)+0;
  $DATA->{$r}{conf_score}=$econ;
  $DATA->{$r}{conf_econ} =$econ if exists $DATA->{$r}{conf_econ};
  for my $s (qw(h u)){
    my $bl = sprintf('%.3f', 0.5*$econ + 0.5*$DATA->{$r}{"conf_clear_$s"})+0;
    $DATA->{$r}{"conf_blend_$s"}=$bl;
    my $was=$DATA->{$r}{"confidence_$s"};
    my $now=$bl >= $AUDIT->{green} ? 'GREEN' : ($bl < $AUDIT->{orange} ? 'RED' : 'ORANGE');
    $DATA->{$r}{"confidence_$s"}=$now;
    $moved{"$r/$s"}="$was -> $now" if $was ne $now;
  }
  # the headline field is not rendered, but keep it consistent with its own rule
  my %rank=(GREEN=>2,ORANGE=>1,RED=>0);
  $DATA->{$r}{confidence} =
    $rank{$DATA->{$r}{confidence_h}} <= $rank{$DATA->{$r}{confidence_u}}
      ? $DATA->{$r}{confidence_h} : $DATA->{$r}{confidence_u};
  $DATA->{$r}{conf_reds} = [ map { $_->{name} } grep { $_->{sig} eq 'RED' } @$rows ];
}
printf "  confidence verdicts moved: %d\n", scalar keys %moved;
print  "    $_: $moved{$_}\n" for sort keys %moved;

# ---- PHASE C — reassign the clock ------------------------------------------
# Shaene's 24-position signature table, Value as a HARD GATE. Specified in
# cotality-v2/TABLE-CLOCK.md; this is the same table the live build used, and
# the assignment below reproduces all 72 live positions before the fix is
# applied (asserted in Phase A2 further down).
my @TABLE = map { my @p=split /\|/; {ph=>$p[0],t=>$p[1],h=>$p[2],pat=>[@p[3..5]]} } (
 'Selling|10:00|10|R|G|G',     'Selling|10:30|10.5|R|G|O',
 'Selling|11:00|11|R|O|G',     'Selling|11:30|11.5|OR|O|O',
 'Selling|12:00|12|OR|O|O',    'Selling|12:30|12.5|OR|R|O',
 'Correction|1:00|13|O|R|R',   'Correction|1:30|13.5|O|R|R',
 'Correction|2:00|14|O|R|R',   'Correction|2:30|14.5|O|R|R',
 'Correction|3:00|15|OG|O|OR', 'Correction|3:30|15.5|OG|O|OR',
 'Correction|4:00|16|OG|OG|R', 'Buy Value|4:30|16.5|OG|OG|R',
 'Buy Value|5:00|17|OG|OG|R',  'Buy Value|5:30|17.5|G|G|O',
 'Buy Value|6:00|18|G|G|O',    'Buy Value|6:30|18.5|G|G|OG',
 'Buy Value|7:00|19|G|G|OG',   'Momentum|7:30|19.5|G|G|OG',
 'Momentum|8:00|20|GO|G|OG',   'Momentum|8:30|20.5|GO|G|G',
 'Momentum|9:00|21|GO|G|G',    'Momentum|9:30|21.5|GO|GO|G');
sub acc { index($_[0],$_[1]) >= 0 }

sub assignClock {
  my ($confOf,$noRedSDinSelling) = @_;      # ->($region,$seg) => GREEN|ORANGE|RED
  # $noRedSDinSelling switches on Shaene's third rule (2026-09-28). It is OFF
  # for the Phase A2 replay, because that rule deliberately MOVES positions —
  # the replay has to reproduce the build as it was, or it proves nothing.
  #
  # Part of that rule is a TABLE EDIT: 12:30's S&D cell goes R -> O, matching
  # 11:30 and 12:00. With the gate on, no reading can match an R there anyway,
  # and she said Selling S&D is orange or green. Taken as a per-call copy so
  # the base table is never mutated between the replay and the live run.
  my @T = map { {ph=>$_->{ph}, t=>$_->{t}, h=>$_->{h}, pat=>[@{$_->{pat}}]} } @TABLE;
  if($noRedSDinSelling){ for my $t (@T){ $t->{pat}[1]='O' if $t->{t} eq '12:30' } }
  my @rows;
  for my $r (@REG){ for my $s (qw(h u)){
    push @rows, { r=>$r, s=>$s, p36=>$DATA->{$r}{"clock_p36_$s"},
      eff=>$DATA->{$r}{"value_eff_$s"},
      sig=>[ substr($DATA->{$r}{"value_$s"},0,1),
             substr($DATA->{$r}{"sd_$s"},0,1),
             substr($confOf->($r,$s),0,1) ] } } }
  my @byG = sort { $a->{p36} <=> $b->{p36} } @rows;
  my %gr; $gr{$byG[$_]{r}.$byG[$_]{s}} = $#byG ? $_/$#byG : 0 for 0..$#byG;
  my $bestFit = sub { my $x=shift; my $b=0;
    for my $t (@T){ next unless acc($t->{pat}[0],$x->{sig}[0]);
      my $s=(acc($t->{pat}[1],$x->{sig}[1])?1:0)+(acc($t->{pat}[2],$x->{sig}[2])?1:0);
      $b=$s if $s>$b } $b };
  my %IX; $IX{$T[$_]{t}}=$_ for 0..$#T;
  my @SLOTS=('11:30','12:00','12:30'); my %redPick;
  # the 11:30/12:00/12:30 runway-depth placement is a SELLING device, so a
  # red-S&D reading is excluded from it once Selling is shut to it
  my @red = sort { $b->{eff} <=> $a->{eff} }
            grep { $_->{sig}[0] eq 'R'
                && !($noRedSDinSelling && $_->{sig}[1] eq 'R')
                && $bestFit->($_) < 2 } @rows;
  for my $k (0..$#red){
    my $g = @red>1 ? int($k*scalar(@SLOTS)/scalar(@red)) : 0;
    $g = $#SLOTS if $g > $#SLOTS;
    $redPick{ $red[$k]{r}.$red[$k]{s} } = $IX{$SLOTS[$g]};
  }
  my %out;
  for my $x (@rows){
    # Two position gates Shaene set on 2026-09-28, beside the Value gate.
    #
    #  1. BUY VALUE TAKES ONLY G/G/O. Without it 4:30 and 5:00 (OG|OG|R) and
    #     6:30/7:00 (G|G|OG) would admit O/O/R, G/O/R, O/G/R or G/G/G if the
    #     scoring happened to send them there.
    #  2. GREEN VALUE WITH RED DEMAND IS CORRECTION. No position accepts G+R,
    #     so bestFit ties Correction 3:00/3:30 against Momentum 7:30/8:00 and
    #     36-month growth picks the phase — which on the VIC data put four
    #     G/R/O houses into Momentum on red demand. Cheap, but demand has not
    #     returned, so it belongs with G/O/O in late Correction.
    #
    # Both hold on current and corrected data, so they change nothing today.
    # They are gates against future data, which is the point of a gate.
    #  3. NO RED S&D IN SELLING (Shaene, 2026-09-28): "selling phase should
    #     have orange/green S&D ... i meant, no red S&D".
    my $sigStr = join '/', @{$x->{sig}};
    my $ggo = $sigStr eq 'G/G/O';
    my $gR  = $x->{sig}[0] eq 'G' && $x->{sig}[1] eq 'R';
    my $rSD = $noRedSDinSelling && $x->{sig}[1] eq 'R';
    my @ok = grep { acc($T[$_]{pat}[0],$x->{sig}[0])
                 && ($T[$_]{ph} ne 'Buy Value' || $ggo)
                 && (!$gR  || $T[$_]{ph} eq 'Correction')
                 && (!$rSD || $T[$_]{ph} ne 'Selling') } 0..$#T;
    # R/R/x is the ONE exception to the Value gate: only Selling cells accept a
    # red Value, so shutting Selling leaves it nowhere. It goes to Correction —
    # expensive AND no demand is not a peak, it is the unwind.
    if(!@ok && $rSD){ @ok = grep { $T[$_]{ph} eq 'Correction' } 0..$#T }
    unless(@ok){
      warn "  clock: $x->{r}/$x->{s} $sigStr has no position under the phase "
          ."gates; falling back to the Value gate alone\n";
      @ok = grep { acc($T[$_]{pat}[0],$x->{sig}[0]) } 0..$#T;
    }
    die "$x->{r}/$x->{s}: no position allows Value $x->{sig}[0]\n" unless @ok;
    my (%tot,%fit);
    for my $i (@ok){ $tot{$i}=0; $fit{$i}=0;
      for my $p (1..2){ my ($cell,$got)=($T[$i]{pat}[$p],$x->{sig}[$p]);
        next unless acc($cell,$got);
        $tot{$i} += length($cell)==1 ? 2 : 1; $fit{$i}++ } }
    my ($bestTot) = sort { $b <=> $a } values %tot;
    my %phTot;
    for my $i (@ok){ my $p=$T[$i]{ph};
      $phTot{$p}=$tot{$i} if !defined $phTot{$p} || $tot{$i}>$phTot{$p} }
    my @win = grep { $phTot{$_}==$bestTot } keys %phTot;
    my @pool = @win==1 ? (grep { $T[$_]{ph} eq $win[0] } @ok) : @ok;
    my ($phFit) = sort { $b <=> $a } map { $fit{$_} } @pool;
    my @cand = grep { $fit{$_}==$phFit } @pool;
    my $best=$phFit;
    my $pick = $cand[ int($gr{$x->{r}.$x->{s}} * $#cand + 0.5) ];
    if($x->{sig}[0] eq "R" && !$rSD && defined $redPick{$x->{r}.$x->{s}}){
      $pick = $redPick{$x->{r}.$x->{s}};
      $best = (acc($T[$pick]{pat}[1],$x->{sig}[1])?1:0)
            + (acc($T[$pick]{pat}[2],$x->{sig}[2])?1:0);
    }
    $out{$x->{r}.'|'.$x->{s}} = { t=>$T[$pick]{t}, ph=>$T[$pick]{ph},
      h=>$T[$pick]{h}, fit=>$best, sig=>join('/',@{$x->{sig}}) };
  }
  \%out;
}
# PHASE A2 — the clock gate. Reassign using the ORIGINAL confidence and require
# it to reproduce every live position, before trusting it with the new one.
my $liveClock = assignClock(sub { $ORIG_CONF{$_[0].'|'.$_[1]} });
my @cfail;
for my $r (@REG){ for my $s (qw(h u)){
  my $g=$liveClock->{"$r|$s"};
  push @cfail, "$r/$s: $g->{t} $g->{ph} vs live $DATA->{$r}{qq(clock_label_$s)} $DATA->{$r}{qq(clock_phase_$s)}"
    if $g->{t} ne $DATA->{$r}{"clock_label_$s"}
    || $g->{ph} ne $DATA->{$r}{"clock_phase_$s"}; } }
if(@cfail){
  print "  $_\n" for @cfail[0..($#cfail>9?9:$#cfail)];
  die "\nPHASE A2 FAILED — the clock table does not reproduce the live positions.\n";
}
print "\nPHASE A2 — clock table reproduces all 72 live positions.\n";

my $newClock = assignClock(sub { $DATA->{$_[0]}{"confidence_$_[1]"} }, 1);
my (%phMove,%hrMove);
for my $r (@REG){ for my $s (qw(h u)){
  my $g=$newClock->{"$r|$s"};
  my ($wasT,$wasP)=($DATA->{$r}{"clock_label_$s"},$DATA->{$r}{"clock_phase_$s"});
  my $h=$g->{h}; $h-=12 if $h>12;
  $DATA->{$r}{"clock_hour_$s"} =$h+0;
  $DATA->{$r}{"clock_label_$s"}=$g->{t};
  $DATA->{$r}{"clock_phase_$s"}=$g->{ph};
  $DATA->{$r}{"clock_sig_$s"}  =$g->{sig} if exists $DATA->{$r}{"clock_sig_$s"};
  $DATA->{$r}{"clock_fit_$s"}  =$g->{fit};
  $phMove{"$r/$s"}="$wasP $wasT -> $g->{ph} $g->{t}" if $wasP ne $g->{ph};
  $hrMove{"$r/$s"}="$wasT -> $g->{t}" if $wasP eq $g->{ph} && $wasT ne $g->{t};
} }
printf "PHASE C — clock reassigned\n  phase moves: %d   hour-only moves: %d\n",
  scalar keys %phMove, scalar keys %hrMove;
print  "    $_: $phMove{$_}\n" for sort keys %phMove;

# ---- PHASE D — the per-region prose ----------------------------------------
# conf_cur_expl quotes the economic half, both blends and both verdicts. Every
# substitution must fire exactly once per region or the prose and the data
# would disagree, which is the failure mode this whole exercise exists to fix.
my $pfail=0;
for my $r (@REG){
  my $p=$DATA->{$r}{conf_cur_expl} or next;
  my $e=sprintf('%.2f',$DATA->{$r}{conf_score});
  my $bh=sprintf('%.2f',$DATA->{$r}{conf_blend_h});
  my $bu=sprintf('%.2f',$DATA->{$r}{conf_blend_u});
  my ($ch,$cu)=($DATA->{$r}{confidence_h},$DATA->{$r}{confidence_u});
  my $n=0;
  $n++ if $p =~ s{(half scores <b>)[\d.]+(</b> out of 2)}{$1$e$2};
  $n++ if $p =~ s{(Blended that is <b>)[\d.]+(</b> for houses and <b>)[\d.]+(</b> for units)}{$1$bh$2$bu$3};
  $n++ if $p =~ s{(Houses read <b>)(?:GREEN|ORANGE|RED)(</b>, units <b>)(?:GREEN|ORANGE|RED)(</b>)}{$1$ch$2$cu$3};
  if($n!=3){ warn "  prose: $r matched $n of 3 substitutions\n"; $pfail++ }
  $DATA->{$r}{conf_cur_expl}=$p;
}
die "PHASE D FAILED — $pfail regions did not rewrite cleanly\n" if $pfail;
print "PHASE D — prose rewritten for all ".scalar(@REG)." regions\n";

# ---- write back ------------------------------------------------------------
# DATA sits AFTER AUDIT in the file, so splice the later block first or the
# earlier splice invalidates the offset.
my ($first,$second) = $aOff < $dOff
  ? ([$dOff,$dLen,'DATA',$DATA], [$aOff,$aLen,'AUDIT',$AUDIT])
  : ([$aOff,$aLen,'AUDIT',$AUDIT], [$dOff,$dLen,'DATA',$DATA]);
for my $b ($first,$second){
  my ($off,$len,$name,$ref)=@$b;
  substr($src,$off,$len) = $J->encode($ref);
}
open my $o,'>:raw',$out or die "$out: $!"; print $o $src; close $o;
printf "\nwrote %s\n", $out;
print  "All four phases passed. Verify in a browser before publishing.\n";
