## **Precomputed Atmospheric Scattering** 

## Eric Bruneton, Fabrice Neyret 

## **To cite this version:** 

Eric Bruneton, Fabrice Neyret. Precomputed Atmospheric Scattering. Computer Graphics Forum, 2008, Special Issue: Proceedings of the 19th Eurographics Symposium on Rendering 2008, 27 (4), pp.1079-1086. ⟨10.1111/j.1467-8659.2008.01245.x⟩. ⟨inria-00288758⟩ 

**HAL Id: inria-00288758 https://inria.hal.science/inria-00288758v1** 

Submitted on 18 Jun 2008 

**HAL** is a multi-disciplinary open access archive for the deposit and dissemination of scientific research documents, whether they are published or not. The documents may come from teaching and research institutions in France or abroad, or from public or private research centers. 

L’archive ouverte pluridisciplinaire **HAL** , est destinée au dépôt et à la diffusion de documents scientifiques de niveau recherche, publiés ou non, émanant des établissements d’enseignement et de recherche français ou étrangers, des laboratoires publics ou privés. 

HAL Authorization 

Eurographics Symposium on Rendering 2008 Steve Marschner and Michael Wimmer (Guest Editors) 

_Volume 27_ ( _2008_ ), _Number 4_ 

## **Precomputed Atmospheric Scattering** 

Eric Bruneton and Fabrice Neyret 

EVASION – LJK / Grenoble Universités – INRIA 

## **Abstract** 

_We present a new and accurate method to render the atmosphere in real time from any viewpoint from ground level to outer space, while taking Rayleigh and Mie multiple scattering into account. Our method reproduces many effects of the scattering of light, such as the daylight and twilight sky color and aerial perspective for all view and light directions, or the Earth and mountain shadows (light shafts) inside the atmosphere. Our method is based on a formulation of the light transport equation that is precomputable for all view points, view directions and sun directions. We show how to store this data compactly and propose a GPU compliant algorithm to precompute it in a few seconds. This precomputed data allows us to evaluate at runtime the light transport equation in constant time, without any sampling, while taking into account the ground for shadows and light shafts._ 

Categories and Subject Descriptors (according to ACM CCS): I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism 

## **1. Introduction** 

Atmospheric effects are very important to increase the realism of outdoor scenes in many applications. The sky color gives key indications about the hour of the day, and the aerial perspective gives an important cue to evaluate distances. Rendering these effects in real time, continuously from ground to space, is desirable in many games or applications, such as flight simulators or Earth browsers like Google Earth. This is especially true for applications that target realism, such as Celestia or Nasa WorldWind. However, these applications currently use very basic models to render these effects, which do not give realistic images. 

In this paper we propose a method to render these effects in real time, from any viewpoint from ground to space. This method accounts for multiple scattering, which is important to correctly render twilight, or the shadow of the Earth inside the atmosphere (see Figure 8). It is based on moderate simplifying assumptions that allow us to get a better approximate solution of the rendering equation (compared to previous work), in which most terms can be precomputed. Our 

points, all view and sun directions, and multiple scattering. 

The next sections are organized as follows. Section 2 introduces the physical model and the rendering equation and reviews the related work. Section 3 presents our resolution method to get a precomputable formulation. Sections 4 and 5 present our precomputation and rendering algorithms. Section 6 gives implementation details and presents our results. 

## **2. Atmospheric models** 

Rendering atmosphere illumination relies on two aspects: a physical model of the local medium properties, and a simulation of the global illumination exchanges up to the viewer eyes. This includes exchanges with the ground, which can be modeled as a Lambertian surface with a height field of reflectance α ( **x** , λ ), normal **n** ( **x** ), etc. 

Most computer graphics (CG) papers, starting with [NSTN93], rely on a physical model of the medium comprising air molecules and aerosol particles, summarized in 

> ⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. Published by Blackwell Publishing, 9600 Garsington Road, Oxford OX4 2DQ, UK and 350 Main Street, Malden, MA 02148, USA. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

Section 2.1. However, the classical rendering equation for participating media is rarely completely accounted for in atmospheric CG models, especially for interactive rendering. We restate the general model in Section 2.2 and we present its approximations in previous CG models in Section 2.3. 

## **2.1. Physical model** 

The physical model commonly used in CG is a clear sky model based on two constituents, air molecules and aerosol particles, in a thin spherical layer of decreasing density between _Rg_ = 6360 _km_ and _Rt_ = 6420 _km_ (see Figure 1). 

At each point, the proportion of light that is scattered θ degrees away from its incident direction is given by the product of a scattering coefficient β _[s]_ and of a phase function _P_ . β _[s]_ depends on the particule density and _P_ describes the angular dependency. For air molecules β _[s]_ and _P_ are given by the Rayleigh theory [TS99]: 

**==> picture [187 x 44] intentionally omitted <==**

where _h_ = _r_ − _Rg_ is the altitude, λ the wavelength, _n_ the index of refraction of air, _N_ the molecular density at sea level _Rg_ , and _HR_ = 8 _km_ is the thickness of the atmosphere if its density were uniform. As in [REK[∗] 04], we use β _[s] R_[= (][5][.][8][,][13][.][5][,][33][.][1][)][10][−][6] _[ m]_[−][1][ for][ λ][ = (][680][,][550][,][440][)] _[ nm]_[.] Aerosols also have an exponentially decreasing density, with a smaller height scale _HM_ ≃ 1.2 _km_ . Their phase function is given by the Mie theory, approximated with the CornetteShanks phase function [TS99]: 

**==> picture [184 x 42] intentionally omitted <==**

Unlike air molecules, aerosols absorb a fraction of the incident light. It is measured with an absorption coefficient β _[a] M_[,] which gives the extinction coefficient β _[e] M_[=][ β] _[s] M_[+][ β] _[a] M_[(see] Figure 6 for typical values – β _[e] R_[=][β] _[s] R_[for][air][molecules).] Note that the variation of the index of refraction with altitude causes a small bending of rays (less than 2 degrees [HMS05]). We ignore it for simplicity. 

## **2.2. Rendering equation** 

We recall here the rendering equation in a participating medium, applied to the atmosphere. We note _L_ ( **x** , **v** , **s** ) the radiance of light reaching **x** from direction **v** when the sun is in direction **s** , and **x** _o_ ( **x** , **v** ) the extremity of the ray **x** + _t_ **v** (see Figure 1). Note that **x** _o_ is either on the ground or on the top atmosphere boundary _r_ = _Rt_ . The _transmittance T_ between **x** _o_ and **x** , the radiance I of light reflected at **x** _o_ , and the radiance J of light scattered at **y** in direction − **v** are defined as 

**==> picture [209 x 72] intentionally omitted <==**

**Figure 1:** _**Our method** ._ Left: _the reference solution includes singlescattering (a) and multiple-scattering (b) integrated from_ **x** _to_ **x** _o, all accounting for occlusion._ Right: _our approximation. Integration is done from_ **x** _to_ **x** _s, ignoring occlusion (implicit via the use of_ **x** _s). (a) is unchanged. (b) is affected by ignoring occlusion of secondary scatters (this yields both positive and negative bias, and effect is small anyway)._ 

**==> picture [207 x 69] intentionally omitted <==**

**Figure 2:** _**Definitions** ._ (a) _the atmospheric transparency T results from absorption and out scattered light._ (b) I[ _L_ ] _is the light L reflected at_ **x** _o. It is null on the top atmosphere boundary._ (c) J [ _L_ ] _is the light L scattered at_ **y** _in direction_ − **v** _._ (d) S[ _L_ ] _is the light scattered towards_ **x** _between_ **x** _o and_ **x** _, from any direction._ 

follows (see Figure 2): 

**==> picture [210 x 80] intentionally omitted <==**

Note that I is null on the top atmosphere boundary. With these notations the rendering equation is [TS99]: 

**==> picture [185 x 38] intentionally omitted <==**

**==> picture [183 x 20] intentionally omitted <==**

where _L_ 0 is the direct sunlight _Lsun_ attenuated before reaching **x** by _T_ ( **x** , **x** _o_ ). _L_ 0 is null if **v** ̸= **s** , or if the sun is occluded by the terrain, _i.e.,_ if **x** _o_ is on the ground. R[ _L_ ] is the light reflected at **x** _o_ and also attenuated before reaching **x** , and S[ _L_ ] is the _inscattered_ light, _i.e.,_ the light scattered towards **x** between **x** and **x** _o_ (see Figure 2). 

## **2.3. Previous rendering methods** 

Equation 8 is very complex to solve. Hence, many simplifying assumptions have been made in CG to find approxi- 

⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

mate solutions that are easier to compute (see [Slo02] for a survey). Most real-time methods ignore multiple scattering. In this case Equation 8 reduces to _L_ = _L_ 0 + R[ _L_ 0] + S[ _L_ 0]. However, even S[ _L_ 0] is quite complex to solve. Some authors propose analytical solutions at the price of idealisations: flat Earth with constant atmosphere density [HP02], or without Mie scattering [REK[∗] 04]. The flat Earth hypothesis limits them to observers on the ground. Otherwise, S[ _L_ 0] is generally computed by numerical integration [NSTN93], which can be done in real time using low sampling [O’N05]. A notable exception is [SFE07] who rely on precomputations of this integral. However, in order to reduce the number of parameters, they only take into account the view and sun zenith angles, and neglect the angle between the view and sun directions. Hence they cannot reproduce, _e.g.,_ the Earth’s shadow inside the atmosphere. 

Ignoring multiple scattering as above is acceptable for daylight but not for twilight [HMS05]. This is because sunlight traverses much less atmosphere during the day than during sunset or sunrise. Hence, some authors propose methods to account for multiple scattering. [PSS99] fit the results of a double scattering Monte-Carlo simulation with an analytical model, but their model is only valid for an observer on the ground. [NDKY96] and [HMS05] use volume radiosity algorithms to compute multiple scattering, but their methods are far from real-time (minutes to hours per image). 

In this paper we propose a new method to render the sky and the aerial perspective in real time, from _all viewpoints_ from ground to space, while taking _multiple scattering_ into account. It is inspired by [SFE07] and extends it with multiple scattering, with the previously ignored view-sun angle parameter, with a better parameterization for the precomputed tables, and with a new method for light shafts. 

## **3. Our method** 

For and realism, our goal is to precompute _L_ as much as possible, with only minimal approximations. Our solution is based on an exact computation for zero and single scattering, and uses an approximation of occlusion effects to compute multiple scattering. In fact we take the detailed ground shape into account for zero and single scattering, in order to get correct ground colors, shadows and light shafts. But we approximate it with a perfect sphere of constant reflectance to compute multiple scattering, to allow for precomputation. 

**Notations** Before presenting our method we need some notations and auxiliary functions. We note _L_[¯] = _L_[¯] 0 +(R[¯] +S[¯] )[ _L_[¯] ] the solution of Equation 8 for the case of a perfectly spherical ground of constant reflectance α ¯ . _L_[¯] 0, R[¯] , S[¯] , **x** ¯ _o_ , I[¯] and so on are defined as before, but for this spherical ground. Note that thanks to the ground’s spherical symmetry **x** and **v** can be reduced to an altitude and a view zenith angle. Hence 

functions of **x** , **v** , **s** such as _L_[¯] or S[¯] [ _L_[¯] ] can be reduced to functions of 4 parameters (2 for **x** , **v** and 2 for **s** ). Note also that _L_ (resp. _L_[¯] ) can be expressed with a series in the linear operators R and S (resp. R[¯] and S[¯] ), where the _i_[th] term corresponds to light reflected and/or scattered exactly _i_ times: 

**==> picture [204 x 24] intentionally omitted <==**

**Zero and single scattering** We compute _L_ 0 and R[ _L_ 0] exactly, during rendering. For this we use a shadowing algorithm to compute the sun occlusion (see Equation 9), and a precomputed table for the transmittance _T_ , which depends on only 2 parameters (see Section 4). S[ _L_ 0] is more complicated. It is an integral between **x** and **x** _o_ but, due to the occlusion term in _L_ 0, the integrand is null at all points **y** that are in shadow (this is what gives light shafts). We suppose here that these points are between **x** _s_ and **x** _o_ (see Figure 1 – the general case is discussed in Section 5). Then the integral can be reduced to the lit segment [ **x** , **x** _s_ ]. Moreover, occlusion can be ignored since it is already accounted for via **x** _s_ , _i.e., L_ 0 can By rewriting this asbe replaced with _L_[¯] 0�. **xx** ¯This _o[T]_[J] shows[ [] _[L]_[¯][0][]][−] that� **xx** ¯ _so[T]_ S[J] [ _L_[ [] _[L]_ 0[¯] ] =[0][]][, extending an] � **xx** _s[T]_[J][ [] _[L]_[¯][0][]][.] idea introduced in [O’N05] and reused in [SFE07], we finally get a formulation using precomputable functions of 2 and 4 parameters, _T_ and S[¯] [ _L_[¯] 0]: 

**==> picture [212 x 10] intentionally omitted <==**

**Multiple scattering** As shown above _L_ 0 and _L_ 1 can be computed exactly despite the occlusion. Unfortunately accounting for occlusion in the other terms _L_ 2 + ... = R[ _L_ ∗]+ S[ _L_ ∗] is much more difficult. Hopefully, in this case the occlusion can be approximated. Indeed, multiple scattering effects are small compared to single scattering during the day, while the ground contribution is small when it is not directly lit by the sun. So we approximate occlusion effects in S[ _L_ ∗] by integrating the contribution of multiple scattering, computed without occlusion, between **x** and **x** _s_ . This yields both positive and negative bias (see Figure 1). Mathematically, this approximation gives S[ _L_ ∗] ≃ � **xx** _s[T]_[J][ [] _[L]_[¯][∗][]][.][We][also][ap-] proximate occlusion effects in R[ _L_ ∗] with the ambient occlusion of an horizontal hemisphere due to the ground’s tangent plane,[1][+] 2 **[n]**[.] **[n]**[¯] . This gives R[ _L_ ∗] ≃ R[ˆ] [ _L_[¯] ∗] with: 

**==> picture [211 x 43] intentionally omitted <==**

By using the same rewriting rule as for Equation 13, and by noting S[¯] [ _L_[¯] ]| **x** = S[¯] [ _L_[¯] ]( **x** , **v** , **s** ), we finally get: 

_L_ ≃ _L_ 0 + R[ _L_ 0] + R[ˆ] [ _L_[¯] ∗] + S[¯] [ _L_[¯] ]| **x** − _T_ ( **x** , **x** _s_ )S[¯] [ _L_[¯] ]| **x** _s_ (16) where the first three terms can be quickly computed with the Shelp¯[ _L_ ¯ ] can be precomputedof precomputed 2D tablesin a 4D table. We now showfor _T_ and E[¯] [ _L_[¯] ∗], and wherehow to precompute them, in tables of a reasonnable size. 

⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

**Algorithm 4.1:** PRECOMPUTE( _norders_ ) 

T( **x** , **v** ) ← _T_ ( **x** , ¯ **x** _o_ ( **x** , **v** )) ∆ E( **x** , **s** ) ← E[¯] [ _L_[¯] 0]( **x** , **s** ) ∆ S( **x** , **v** , **s** ) ← S[¯] [ _L_[¯] 0]( **x** , **v** , **s** ) E( **x** , **s** ) ← 0 S( **x** , **v** , **s** ) ← ∆ S( **x** , **v** , **s** ) 

**for** _i_ ← 1 **to** _i_ < _norders_ 

- **do**  ∆∆∆ EJES( **x** ((( **x** , **xxs** ,,,) **vvs** ←,,) **s** ← **s** )) ←J ←EE([¯] **x** [ _T_ , **xsx** [¯[α] )+ π _o_[¯] _T[T]_[∆][α] π[¯][E][(] ∆[∆] **[x]**[+] E[,][E] **[y]** ([∆][)][+] **x**[∆][S] ,[∆][J] **s**[](] )[(][S] **[x][y]**[](][,][,] **[s][x][v]**[) =][,][,] **[v][s]**[)][,] _[dy]_ **[s]**[E][¯][)][[][∆][S][](] **[x]**[,] **[s]**[)] S( **x** , **v** , **s** ) ← S( **x** , **v** , **s** )+ ∆ S( **x** , **v** , **s** ) 

**Figure 3:** _**Viewing angle parameter** ._ Left: _using µ gives artifacts._ Right: _using uµ_ = _do_ / _dh or do_ / _dH solves the problem (using 128 values for µ or uµ in the precomputed sky radiance table_ S _)._ 

## **4. Precomputations** 

We precompute _T_ ( **x** , ¯ **x** _o_ ( **x** , **v** )) for all **x** , **v** in a 2D table T( **x** , **v** ). Due to spherical symmetry, T depends only on _r_ = ∥ **x** ∥ and _µ_ = **v** . **x** / _r_ [O’N05]. As [O’N05], we then use the identity _T_ ( **x** , **y** ) = T( **x** , **v** )/T( **y** , **v** ), with **v** = ( **y** − **x** )/∥ **y** − **x** ∥. 

We precompute E[¯] [ _L_[¯] ∗] and S[¯] [ _L_[¯] ] in two tables E and S with an algorithm that computes each scattering order _L_[¯] _i_ one after the other. This algorithm uses three intermediate tables ∆ E, ∆ S and ∆ J containing after each iteration _i_ E[¯] [ _L_[¯] _i_ ], S[¯] [ _L_[¯] _i_ ] and J [ _L_[¯] _i_ ]. ∆ E and ∆ S are added to the result tables E and S at Rthe¯ [ _L_ end]( **x** , **v** of, **s** each) = _T_ iteration( **x** , ¯ **x** _o_ )[α] π[¯][E] ([¯] R[[][¯] _[L]_[](] is **[x]**[¯] _[o]_ computed[,] **[s]**[)][ – see Algorithm] with the identity[ 4.1][).] 

**Angular precision** Since S is a 4D table its size increases very quickly with resolution. So we can only use a limited angular resolution for **v** . This poses a precision problem, which is however limited to the strong forward Mie scattering. In order to solve it we separate the single Mie scattering term from all the others in S, so as to apply the phase function at runtime. For this we rewrite S[¯] [ _L_[¯] ] as _PM_ S[¯] _M_ [ _L_[¯] 0]+ _PR_ S[¯] _R_ [ _L_[¯] 0]+ S[¯] [ _L_[¯] ∗]. We then store _CM_ = S[¯] _M_ [ _L_[¯] 0] and _C_ ∗ = S[¯] _R_ [ _L_[¯] 0] + S[¯] [ _L_[¯] ∗]/ _PR_ separately, which requires 6 values per entry in S. If necessary, for efficiency, this can be reduced to 4 values per entry by storing only the red combe approximated with a proportionality rule betweenponent _CM_ , _r_ of _CM_ . In this case the other componentsS[¯] _M_ [can _L_[¯] 0] and S[¯] _R_ [ _L_[¯] 0], which gives _CM_ ≃ _C_ ∗ _CCM_ ∗,, _rr_ ββ _[s] M[s] R_ ,, _rr_ ββ _[s] M[s] R_[.] 

**Parameterization** In order to store S[¯] [ _L_[¯] ] into S we need a mapping from ( **x** , **v** , **s** ) into table indices in [0, 1][4] . A simple solution is to use _r_ = ∥ **x** ∥ and the cosinus of the view zenith, sun zenith, and view sun angles, _µ_ = **v** . **x** / _r_ , _µs_ = **s** . **x** / _r_ and ν = **v** . **s** (mapped linearly from [ _Rg_ , _Rt_ ] × [−1, 1][3] to [0, 1][4] ). 

The problem of this parameterization is that it requires a very high resolution in _µ_ to get a good sampling for the aerial perspective. Consider for instance an observer near the ground looking horizontally, with a mountain at distance _d_ (see Figure 3). The aerial perspective is given by Equation 16 as S( **x** , **v** , **s** ) − _T_ ( **x** , **x** _s_ )S( **x** _s_ , **v** , **s** ). Then _µ_ = 0 for **x** , 

**Figure 4:** _**Parameterization** . ur, uµ, uµs as functions of r, µ, µs._ 

and _d_ /√ _r_[2] + _d_[2] for **x** _s_ , which gives ∆ _µ_ = 0.016 ≪ 1 for _d_ = 100 _km_ . This too small value gives visible artifacts (see Figure 3). In order to solve this problem we rely on a better parameterization. We replace _µ_ with _uµ_ , defined as the ratio between the distance _do_ = ∥ **x** ¯ _o_ − **x** ∥ and the distance _dh_ (resp. _dH_ ) from **x** to the horizon (resp. to the atmosphere boundary “behind” the horizon – see Figure 3). In the previous example _dH_ ≃ ( _Rt_[2] − _R_[2] _g_ )[1][/][2] for **x** and **x** _s_ , while _do_ ≃ _dH_ for **x** and _dH_ − _d_ for **x** _s_ , which gives ∆ _uµ_ = 0.11 ≫ 0.016 for _d_ = 100 _km_ . With this mapping 128 samples for _uµ_ are 

Another problem is that S is discontinuous at the horizon, due to the discontinuity of the length of the viewing ray here. Hence a continuous mapping yields linear interpolations across this discontinuity, which causes artifacts. We solve this problem by ensuring that _uµ_ is itself discontinuous at the horizon (see Figure 4). Finally, we use an ad hoc non linear mapping for _r_ and _µs_ , chosen so as to get a better precision near the ground and for sun zenith angles near 90[o] . So our mapping from ( **x** , **v** , **s** ) into [0, 1][4] is finally defined as follows: 

**==> picture [187 x 66] intentionally omitted <==**

**==> picture [215 x 13] intentionally omitted <==**

⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

**Figure 5:** _**Evaluation of** l._ Left: _due to the false boundaries b and c, the computed length_ ∆ _z_ − ∆ _n_ . _zg_ = _zg_ − _za_ + _zc_ − _zb is larger than l. Clamping this value to zg_ − _zmin fixes the problem._ Right: _viewpoint in shadow. Using only the extruded edges,_ **x** _o would be seen as lit and l would be equal to_ 0 _instead of zg_ − _znear. Projecting the back faces (dashed line) on the near plane solves the issue [HHLH05]._ 

## **5. Rendering** 

In order to render the sky and the aerial perspective we evaluate Equation 16 at each pixel. _L_[¯] 0 can be efficiently computed using T. Computing R[ _L_[¯] 0] involves T, α ( **x** _o_ ) and **n** ( **x** _o_ ), and a shadow test to determine whether **x** _o_ is lit. Finally E and S are used to compute R[ˆ] [ _L_[¯] ∗] and S[¯] [ _L_[¯] ]. As in [SFE07], **x** is the camera position or, if in space, the nearest intersection of the viewing ray with the atmosphere boundary. The only remaining non-trivial parameter is **x** _s_ , which depends on the terrain shadows and gives light shafts. 

Most light shaft algorithms use sampling or slicing to perform a numerical integration along the viewing ray, with a shadow map to find which samples are lit. Up to 100 samples per ray must be used to eliminate the artifacts due to the discrete sampling [IJTN07]. We propose here a new method inspired from shadow volumes [HHLH05]. It does not rely on numerical integration, and therefore does not suffer from these artifacts. We first show that an exact computation is possible but not adapted to the GPU. We then present an approximate solution better adapted to the GPU. Our idea is to use the precomputed integral S to compute the inscattered light due to each lit segment [ **x** _i_ , **x** _i_ +1] along the viewing ray, which is given by _T_ ( **x** , **x** _i_ )S| **x** _i_ − _T_ ( **x** , **x** _i_ +1)S| **x** _i_ +1 . By definition the points **x** _i_ are on the boundaries of the shadow volume of the terrain. Hence they can be found with a shadow volume algorithm such as [HHLH05]. This algorithm extrudes the silhouette edges of objects, as seen from the light; it also projects these objects on the near plane to get correct results despite clipping. However these algorithms also generate many surfaces that do not correspond to a boundary between light and shadow (see Figure 5). These false boundaries must be ignored when computing the inscattered light, otherwise a wrong result is obtained. Unfortunately, detecting them is a non local operation that is not adapted to GPU (requiring, _e.g.,_ the use of multiple passes, or list structures). 

Our solution is to use the shadow volume algorithm to compute the total length _l_ of the shadowed segments, and to replace them with a single segment of this length at the “ground” end of the ray (see Figure 5). The false boundaries still cause problem, _i.e.,_ an overestimation of _l_ . Here how- 

**Figure 6:** _**Validation.** The sky luminance_ S _in fisheye view for several sun zenith angles, in color, and relatively to the zenith luminance. With_ α ¯ = 0.1 _,_ β _[s] M_[=][ 210][−][5] _[m]_[−][1] _[,]_[β] _[s] M_[/][β] _[e] M_[=][ 0][.][9] _[,][g]_[ =][ 0][.][76] _and HM_ = 1.2 _km we get the CIE clear sky model, fitted from actual measurements (source [ZWP07])._ 

ever _l_ can be clamped to the distance between the nearest and farthest faces of the shadow volume. This gives the correct result in most cases, and an approximate value in the others. Our detailed algorithm is the following. We associate with each pixel 4 values ∆ _n_ , ∆ _z_ , _zmin_ , _zmax_ initialized to 0, 0, ∞, 0. In a first step we decrement (resp. increment) ∆ _n_ by 1 and ∆ _z_ by the fragment depth _z_ , and update _zmin_ and _zmax_ with _z_ , for each front (resp. back) face of the shadow surface. In a second step we use (see Figure 5) 

**==> picture [159 x 12] intentionally omitted <==**

_L_ ≃ _L_ 0 + R[ _L_ 0] + R[ˆ] [ _L_[¯] ∗] + S| **x** − _T_ ( **x** , **x** _s_ )S| **x** _s_ = **x** _o_ − _l_ ˜ **v** (17) 

when looking at the ground or, when looking at the sky: ˜ _l_ = clamp( ∆ _z_ , 0, _zmax_ ) 

**==> picture [208 x 14] intentionally omitted <==**

## **6. Implementation, results and discussion** 

**Precomputations** We have implemented the precomputation algorithm on GPU, with fragment shaders processing the numerical integration. This is not mandatory but it allows us to quickly change atmospheric parameters, and it saves disk space (indeed 5 scattering orders are computed in 5 _seconds_ on a NVidia 8800 GTS). We store T( _r_ , _µ_ ) and E( _r_ , _µ_ ) in 64 × 256 and 16 × 64 textures. We store S( _ur_ , _uµ_ , _uµs_ , _u_ ν ) = [ _C_ ∗, _CM_ , _r_ ] in a 32 × 128 × 32 × 8 table, seen as 8 3D tables packed in a single 32 × 128 × 256 RGBA texture (using a manual linear interpolation for the 4 _[th]_ coordinate). Thanks to our optimized parameterization our 4D table has a better precision and uses less space than the 3D table of [SFE07] (8 MB for S with 16 bits floats _vs_ 12 MB for their 128[3] texture). 

## **Rendering** The rendering is done in four passes: 

- we draw the terrain in the depth buffer only; 

- we draw the shadow volume of the terrain into a ∆ _n_ , ∆ _z_ , _zmin_ , _zmax_ texture. For this we use the `ADD` and `MAX` blending functions, disable depth write, and use a geometry shader that extrudes the silhouette edges (as seen from the sun). This shader also projects on the near plane along − **s** 

> ⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

the back faces (as seen from the sun) that are between this plane and the sun [HHLH05]; 

- we draw the terrain and the other objects with aerial perspective, as well as the sky, using Equations 17 and 18. If there are transparent objects such as clouds, aerial perspective must be computed for each object, before blending. We use ∆ _n_ to compute occlusion in R[ _L_ 0], and _l_[˜] computed as above to get **x** _s_ (see Section 5); 

- 

**Results** We run several tests with a height and a reflectance texture from Nasa’s Earth Observatory [SVS[∗] 05]. Results are depicted in Figures 8 and 9. As shown in Figures 6 and 7 our model can reproduce with good accuracy the CIE clear sky model, fitted from actual measurements at the ground level [DK02]. Since the sky color and aerial perspective are computed with a few texture fetches per pixel (< 10), our algorithm is quite fast. For instance, for the right view in Figure 8 in 1024 × 768, we get 125 fps without light shafts on a NVidia 8800 GTS. This includes 5 ms for the unshaded terrain, 0.4 ms for the first three terms in Equations 17 and 18 and 2.6 ms for the remaining terms (including 1 ms to evaluate the non linear parameterization). We get 25 fps with light shafts ( _i.e.,_ the first two rendering passes cost a lot, about 32 ms). By comparison, we get 50 fps with our reimplementation of [O’N05], using ten samples per ray (to get the same quality for single scattering, without shafts). 

**Limitations** A limitation of our method is that the aerosol properties are assumed constant, depending only on altitude, whereas in fact they can greatly change depending on the atmospheric conditions [Slo02]. Since our precomputations are very fast we can change these properties quickly, but they remain uniform. 

## **7. Conclusion** 

We have presented the real-time method to render the sky and the aerial perspective from all viewpoints, with multiple scattering, terrain shadows and light shafts, and correct variation with all view and sun angles. This method is based on minimal simplifying assumptions that allow us to get an approximate solution of the rendering equation, in which most terms can be precomputed. This method can easily be extended to more complex physical models, with more constituents or more wavelengths. 

As future work we would like to model the effect of clouds on the ground illuminance and on the aerial perspective, to remove the clear sky hypothesis. Indeed with many clouds the interreflections between the ground and the clouds should be taken into account [BNL06]. And their effect on aerial perspective should also be considered. To our knowledge, this has never been done. 

The source code of our implementation is available at `http://evasion.inrialpes.fr/~Eric.Bruneton/` . 

**Acknowledgments** This work was partially funded by the Natsim ANR ARA project. We would like to thank Antoine Bouthors and Cyril Soler for proofreading. 

## **References** 

- [BNL06] BOUTHORS A., NEYRET F., LEFEBVRE S.: Real-time realistic illumination and shading of stratiform clouds. In _Eurographics Workshop on Natural Phenomena_ (sep 2006). 

- [DK02] DARULA S., KITTLER R.: CIE general sky standard defining luminance distributions. _eSim_ (2002). 

- [HHLH05] HORNUS S., HOBEROCK J., LEFEBVRE S., HART J. C.: ZP+: correct Z-pass stencil shadows. In _ACM Symposium on Interactive 3D Graphics and Games (I3D)_ (April 2005), ACM, ACM Press. 

- [HMS05] HABER J., MAGNOR M., SEIDEL H.-P.: Physicallybased simulation of twilight phenomena. _ACM Trans. Graph. 24_ , 4 (2005), 1353–1373. 

- [HP02] HOFFMAN N., PREETHAM A. J.: Rendering outdoor light scattering in real time. _Proceedings of Game Developer Conference_ (2002). 

- [IJTN07] IMAGIRE T., JOHAN H., TAMURA N., NISHITA T.: Anti-aliased and real-time rendering of scenes with light scattering effects. _Vis. Comput. 23_ , 9 (2007), 935–944. 

- [NDKY96] NISHITA T., DOBASHI Y., KANEDA K., YAMASHITA H.: Display method of the sky color taking into account multiple scattering. In _Proceedings of Pacific Graphics_ (1996), pp. 117–132. 

- [NSTN93] NISHITA T., SIRAI T., TADAMURA K., NAKAMAE E.: Display of the Earth taking into account atmospheric scattering. In _SIGGRAPH 93_ (1993), ACM, pp. 175–182. 

- [O’N05] O’NEIL S.: Accurate atmospheric scattering. In _GPU Gems 2: Programming Techniques for High-Performance Graphics and General-Purpose Computation_ (2005), Addison-Wesley Professional. 

- [PSS99] PREETHAM A. J., SHIRLEY P., SMITS. B. E.: A practical analytic model for daylight. In _SIGGRAPH 99_ (1999). 

- [REK[∗] 04] RILEY K., EBERT D. S., KRAUS M., TESSENDORF J., HANSEN C. D.: Efficient rendering of atmospheric phenomena. In _Rendering Techniques_ (2004), pp. 374–386. 

- [SFE07] SCHAFHITZEL T., FALK M., ERTL T.: Real-time rendering of planets with atmospheres. In _WSCG International Conference in Central Europe on Computer Graphics, Visualization and Computer Vision_ (2007). 

- [Slo02] SLOUP J.: A survey of the modelling and rendering of the Earth’s atmosphere. In _SCCG ’02: Proceedings of the 18th spring conference on Computer graphics_ (2002), ACM, pp. 141–150. 

- [SVS[∗] 05] STOCKLI R., VERMOTE E., SALEOUS N., SIMMON R., HERRING D.: The Blue Marble Next Generation – a true color Earth dataset including seasonal dynamics from MODIS. _NASA Earth Observatory_ (2005). 

- [TS99] THOMAS G. E., STAMNES K.: _Radiative transfer in the atmosphere and ocean_ . Cambridge Univ. Press, 1999. 

- [ZWP07] ZOTTI G., WILKIE A., PURGATHOFER W.: A critical review of the Preetham skylight model. In _WSCG 2007 Short Communications Proceedings I_ (Jan. 2007), pp. 23–30. 

⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

**==> picture [434 x 332] intentionally omitted <==**

**----- Start of picture text -----**<br>
 1  1.6  3<br>CIE Model CIE Model CIE Model<br>Our Model  1.4 Our Model Our Model<br> 2.5<br> 0.8<br> 1.2<br> 2<br> 0.6  1<br> 0.8  1.5<br> 0.4  0.6<br> 1<br> 0.4<br> 0.2<br> 0.5<br> 0.2<br> 0  0  0<br>-80 -60 -40 -20  0  20  40  60  80 -80 -60 -40 -20  0  20  40  60  80 -80 -60 -40 -20  0  20  40  60  80<br>View angle View angle View angle<br> 4  6  10<br>CIE  Model CI E Mo del CIE Model<br> 3.5 O u r M odel O ur Mo del  9 Our Model<br> 5  8<br> 3<br> 4  7<br> 2.5  6<br> 2  3  5<br> 1.5  4<br> 2<br> 3<br> 1<br> 2<br> 1<br> 0.5  1<br> 0  0  0<br>-80 -60 -40 -20  0  20  40  60  80 -80 -60 -40 -20  0  20  40  60  80 -80 -60 -40 -20  0  20  40  60  80<br>View angle View angle View angle<br> 18  35  60<br>CIE Model CIE Model CIE Model<br> 16 Our Model  30 Our Model  50 Our Model<br> 14<br> 25<br> 12  40<br> 10  20<br> 30<br> 8  15<br> 6 Fa ‘3  20<br> 10<br> 4 2 ~ * yA  5 a yi  10 f<br> 0  0  0<br>-80 -60 -40 -20  0  20  40  60  80 -80 -60 -40 -20  0  20  40  60  80 -80 -60 -40 -20  0  20  40  60  80<br>View angle View angle View angle<br>Relative sky luminance (sun zenith angle = 0) Relative sky luminance (sun zenith angle = 10) Relative sky luminance (sun zenith angle = 20)<br>Relative sky luminance (sun zenith angle = 30) Relative sky luminance (sun zenith angle = 40) Relative sky luminance (sun zenith angle = 50)<br>Relative sky luminance (sun zenith angle = 60) Relative sky luminance (sun zenith angle = 70) Relative sky luminance (sun zenith angle = 80)<br>**----- End of picture text -----**<br>


**Figure 7:** _**Validation.** The sky luminance relatively to the zenith luminance for several sun zenith and view zenith angles (and null azimuth between view and sun directions). Comparison between our model (with_ α ¯ = 0.1 _,_ β _[s] M_[=][ 2][.][210][−][5] _[ m]_[−][1] _[,]_[ β] _[s] M_[/][β] _[e] M_[=][ 0][.][9] _[, g]_[ =][ 0][.][73] _[ and H][M]_[=][ 1][.][2] _[ km)] and the CIE sky model 12 (based on actual measurements). We note an overestimation near the horizon (view angles near 90 and -90), which is also visible in Figure 6. As shown in [ZWP07] the Preetham model [PSS99] also suffers from this problem, which probably comes from the physical models currently used in CG._ 

**Figure 8:** _**Results.**_ (a), from top to bottom: _[SFE07], single scattering, multiple scattering and photo. With [SFE07] the shadow does not appear due to the missing_ ν _parameter. It is too dark with single sattering only._ (b) _sunset viewed from space._ (c) _the view used for our performance measurements._ 

⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

_E. Bruneton & F. Neyret / Precomputed Atmospheric Scattering_ 

**Figure 9:** _**Results.** Our results (_ no frames _) compared with real photographs found on the Web (_ red frames _). The tone mapping may explain the sky hue differences on some images compared with the uncalibrated photographs._ 

Views from space for various altitudes and sun positions. 

Views from the ground showing, from left to right, the Earth shadow, the aerial perspective after sunset, sunset, and light shafts at sunrise. 

Aerial perspective during the day, and mountain shadows for various view and sun angles. 

⃝c 2008 The Author(s) Journal compilation ⃝c 2008 The Eurographics Association and Blackwell Publishing Ltd. 

